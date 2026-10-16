/**
 * Hosted group chat on this Mac.
 *
 *   node scripts/groupchat.ts init                       generate secrets + configs (idempotent)
 *   node scripts/groupchat.ts add-user <name> [password] create an account for you or a friend
 *   node scripts/groupchat.ts start                      tunnel + bot; prints the link to share
 *
 * Env: SYNAPSE_MODEL (default gemma3:4b), SYNAPSE_INFERENCE_BASE_URL
 * (default Ollama, http://localhost:11434/v1), INFERENCE_API_KEY.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matrixAdmin } from './matrix-admin.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(root, '.local');
const PROXY_URL = 'http://localhost:8090';

/** Reads a secret from .local/, generating it on first use. */
function secret(name: string): string {
  const file = path.join(stateDir, name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

function writeElementConfig(baseUrl: string) {
  const dir = path.join(stateDir, 'element');
  fs.mkdirSync(dir, { recursive: true });
  const config = {
    default_server_config: { 'm.homeserver': { base_url: baseUrl, server_name: 'test.local' } },
    disable_custom_urls: true,
    disable_guests: true,
    brand: 'Element',
    setting_defaults: { 'UIFeature.registration': false },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function init() {
  const target = path.join(stateDir, 'synapse', 'homeserver.yaml');
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const yaml = fs
      .readFileSync(path.join(root, 'local', 'homeserver.template.yaml'), 'utf8')
      .replace('__REGISTRATION_SECRET__', secret('registration-secret'))
      .replace('__MACAROON_SECRET__', secret('macaroon-secret'))
      .replace('__FORM_SECRET__', secret('form-secret'));
    fs.writeFileSync(target, yaml, { mode: 0o600 });
  }
  if (!fs.existsSync(path.join(stateDir, 'element', 'config.json'))) writeElementConfig(PROXY_URL);
}

const admin = () => matrixAdmin({ homeserverUrl: 'http://localhost:8008', registrationSecret: secret('registration-secret') });

async function addUser(name: string | undefined, password = randomBytes(9).toString('base64url')) {
  if (!name || !/^[a-z0-9._=-]+$/.test(name)) throw new Error('usage: add-user <name> [password]  (lowercase letters, digits, . _ = -)');
  const { registerUser, waitForHomeserver } = admin();
  await waitForHomeserver();
  const creds = await registerUser({ localpart: name, displayName: name[0].toUpperCase() + name.slice(1), password });
  console.log(`Created ${creds.userId}\n  username: ${name}\n  password: ${password}`);
}

/** Starts a Cloudflare quick tunnel to the proxy and resolves with its public URL. */
function startTunnel(): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', PROXY_URL], { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('cloudflared did not report a tunnel URL within 60s')), 60_000);
    proc.on('error', (err) => reject(new Error(`could not run cloudflared (brew install cloudflared): ${err.message}`)));
    proc.stderr!.on('data', (chunk: Buffer) => {
      const url = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (url) {
        clearTimeout(timer);
        resolve({ url, proc });
      }
    });
  });
}

async function waitForPublicUrl(url: string) {
  // New quick-tunnel hostnames take a few seconds to propagate.
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${url}/_matrix/client/versions`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tunnel ${url} never became reachable`);
}

async function start() {
  init();
  const { provisionBot, waitForHomeserver } = admin();
  await waitForHomeserver();

  const baseUrl = process.env.SYNAPSE_INFERENCE_BASE_URL ?? 'http://localhost:11434/v1';
  const model = process.env.SYNAPSE_MODEL ?? 'gemma3:4b';
  const models = await fetch(`${baseUrl}/models`).then((r) => r.json() as Promise<{ data?: Array<{ id: string }> }>, () => undefined);
  if (!models) throw new Error(`No model server at ${baseUrl}. Open Ollama (or set SYNAPSE_INFERENCE_BASE_URL).`);
  if (models.data && !models.data.some((m) => m.id === model)) {
    throw new Error(`Model "${model}" not found at ${baseUrl}. Available: ${models.data.map((m) => m.id).join(', ')}`);
  }

  const children: ChildProcess[] = [];
  const shutdown = (code = 0) => {
    for (const child of children) child.kill('SIGTERM');
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  const tunnel = await startTunnel();
  children.push(tunnel.proc);
  writeElementConfig(tunnel.url);
  await waitForPublicUrl(tunnel.url);

  const password = secret('bot-password');
  const bot = await provisionBot({ localpart: 'synapse', displayName: 'Synapse', deviceId: 'SYNAPSE_CORE_01', password });
  const agent = spawn(process.execPath, [path.join(root, 'src/main.ts'), path.join(root, 'local/agent.config.yaml')], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      MATRIX_ACCESS_TOKEN: bot.accessToken,
      MATRIX_PASSWORD: password,
      CRYPTO_STORE_PASSPHRASE: secret('crypto-passphrase'),
      INFERENCE_API_KEY: process.env.INFERENCE_API_KEY ?? 'ollama',
      SYNAPSE_INFERENCE_BASE_URL: baseUrl,
      SYNAPSE_MODEL: model,
      SYNAPSE_DASHBOARD_PORT: process.env.SYNAPSE_DASHBOARD_PORT ?? '9470',
      SYNAPSE_SETTINGS_PATH: path.join(stateDir, 'settings.yaml'),
    },
  });
  children.push(agent);
  agent.on('exit', (code) => shutdown(code ?? 0));
  tunnel.proc.on('exit', () => {
    console.error('Cloudflare tunnel exited; stopping.');
    shutdown(1);
  });

  console.log(`
  Group chat is live: ${tunnel.url}
  Bot: ${bot.userId} (model ${model})
  Settings (this computer only): http://localhost:${process.env.SYNAPSE_DASHBOARD_PORT ?? '9470'}
  Share that link with friends. It changes every time you run this command.
  Press Ctrl+C to stop.
`);
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  init,
  'add-user': () => addUser(args[0], args[1]),
  start,
};
Promise.resolve()
  .then(() => {
    const run = commands[command];
    if (!run) throw new Error('usage: groupchat.ts init | add-user <name> [password] | start');
    return run();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
