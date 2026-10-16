import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { log } from './log.ts';
import {
  JUMP_IN_KEYS,
  PRESETS,
  resolveJumpInSettings,
  validateJumpInSettings,
  type ResolvedSettings,
  type SettingsIssue,
} from './settings.ts';

/**
 * Local settings dashboard for jump-in behaviour.
 *
 * Served on 127.0.0.1 only, and requests whose Host header is not local are
 * refused, so it stays unreachable through the Cloudflare tunnel or any proxy.
 * Overrides persist as YAML at `settingsPath` and are layered over `base`
 * (the config file's `turn_gating`).
 */

export interface DashboardHandle {
  url: string;
  close(): Promise<void>;
}

export interface DashboardOptions {
  port: number;
  host?: string;
  settingsPath: string;
  base: Record<string, unknown>;
  onChange?: (resolved: ResolvedSettings) => void;
}

type Overrides = Record<string, unknown>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_BODY_BYTES = 64 * 1024;

/** Reads saved dashboard overrides; a missing file means none. Invalid content is ignored with a warning. */
export function loadSavedOverrides(settingsPath: string, base: Overrides = {}): Overrides {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const saved = YAML.parse(fs.readFileSync(settingsPath, 'utf8')) ?? {};
    if (typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not a mapping');
    const issues = validateJumpInSettings(saved, JUMP_IN_KEYS);
    if (issues.length) throw new Error(issues.map((i) => `${i.key} ${i.message}`).join('; '));
    resolveJumpInSettings({ ...base, ...saved });
    return saved;
  } catch (err) {
    log.warn('ignoring saved settings in %s: %s', settingsPath, (err as Error).message);
    return {};
  }
}

function writeAtomically(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isLocalHost(hostHeader: string | undefined) {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  return LOCAL_HOSTS.has(host.toLowerCase());
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startDashboard(opts: DashboardOptions): Promise<DashboardHandle> {
  const host = opts.host ?? '127.0.0.1';
  let saved = loadSavedOverrides(opts.settingsPath, opts.base);
  // Saves are applied strictly in arrival order, so the last request wins on disk and in memory.
  let writes = Promise.resolve();

  const snapshot = () => {
    const resolved = resolveJumpInSettings({ ...opts.base, ...saved });
    const fromConfig = JUMP_IN_KEYS.filter((k) => opts.base[k] !== undefined && saved[k] === undefined);
    return { ...resolved, saved, fromConfig };
  };

  const save = (next: Overrides): Promise<{ status: number; body: unknown }> => {
    const result = writes.then(() => {
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        return { status: 400, body: { issues: [{ key: '(body)', message: 'must be a JSON object of settings' }] } };
      }
      let issues: SettingsIssue[] = validateJumpInSettings(next, JUMP_IN_KEYS);
      let resolved: ResolvedSettings | undefined;
      if (!issues.length) {
        try {
          resolved = resolveJumpInSettings({ ...opts.base, ...next });
        } catch (err) {
          issues = (err as { issues?: SettingsIssue[] }).issues ?? [{ key: '(settings)', message: String(err) }];
        }
      }
      if (issues.length || !resolved) return { status: 400, body: { issues } };
      writeAtomically(opts.settingsPath, YAML.stringify(next));
      saved = next;
      opts.onChange?.(resolved);
      return { status: 200, body: snapshot() };
    });
    writes = result.then(() => undefined, () => undefined);
    return result;
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
    };
    try {
      if (!isLocalHost(req.headers.host)) return send(403, { error: 'the settings dashboard is only available on this computer' });
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/') return send(200, page(), 'text/html; charset=utf-8');
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return send(200, snapshot());
        if (req.method === 'PUT') {
          let body: unknown;
          try {
            body = JSON.parse((await readBody(req)) || '{}');
          } catch {
            return send(400, { issues: [{ key: '(body)', message: 'is not valid JSON' }] });
          }
          const { status, body: out } = await save(body as Overrides);
          return send(status, out);
        }
        return send(405, { error: 'method not allowed' });
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      log.error('dashboard: %s', (err as Error).stack ?? err);
      if (!res.headersSent) send(500, { error: 'internal error' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ------------------------------------------------------------------ page

const NUMBER_FIELDS = [
  ['window_size', 'Memory window', 'How many recent messages it reads before deciding there is an argument.', '1'],
  ['min_speakers', 'Minimum people', 'How many different people must be talking.', '1'],
  ['semantic_deadlock_threshold', 'Disagreement sensitivity', 'Share of those messages that must sound heated (0.5 = half, 1 = all).', '0.05'],
  ['cooldown_seconds', 'Cooldown (seconds)', 'Quiet time after it speaks before it may jump in again.', '1'],
  ['settle_seconds', 'Patience (seconds)', 'Wait after the last message so people can finish.', '0.5'],
] as const;

const LIST_FIELDS = [
  ['friction_words', 'Conflict words', 'Extra words that signal disagreement, one per line (e.g. meh, no way).'],
  ['consensus_words', 'Agreement words', 'Extra words that settle a dispute, one per line (e.g. bet, deal).'],
  ['nicknames', 'Nicknames', 'Names that call the bot when they start a message, one per line (e.g. ai).'],
] as const;

function page() {
  const numberRows = NUMBER_FIELDS.map(
    ([key, label, help, step]) => `
      <div class="field" data-key="${key}">
        <div class="row"><label for="f-${key}">${label}</label><span class="tools"><button type="button" class="reset" data-reset="${key}" aria-label="Reset ${label}" hidden>Reset</button><span class="badge" data-testid="source-${key}"></span></span></div>
        <input id="f-${key}" type="number" step="${step}" aria-describedby="h-${key}">
        <p class="help" id="h-${key}">${help}</p>
      </div>`,
  ).join('');
  const listRows = LIST_FIELDS.map(
    ([key, label, help]) => `
      <div class="field" data-key="${key}">
        <div class="row"><label for="f-${key}">${label}</label><span class="tools"><button type="button" class="reset" data-reset="${key}" aria-label="Reset ${label}" hidden>Reset</button><span class="badge" data-testid="source-${key}"></span></span></div>
        <textarea id="f-${key}" rows="3" aria-describedby="h-${key}"></textarea>
        <p class="help" id="h-${key}">${help}</p>
      </div>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapse Settings</title>
<style>
  :root { --bg:#f7f7f8; --card:#fff; --text:#1b1d21; --muted:#5f6673; --line:#dcdfe4; --accent:#0b7a5b; --danger:#b42318; --chip:#eef0f3; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161a; --card:#1d2026; --text:#e8eaed; --muted:#9aa1ad; --line:#30343c; --accent:#3ccf9a; --danger:#ff8a80; --chip:#2a2e36; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width:640px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .lede { color:var(--muted); margin:0 0 20px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  h2 { font-size:15px; margin:0 0 12px; }
  .presets { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .presets label { border:1px solid var(--line); border-radius:10px; padding:10px; cursor:pointer; }
  .presets label:has(input:checked) { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent); }
  .presets small { display:block; color:var(--muted); }
  .field { margin-bottom:14px; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .row label { font-weight:600; }
  input[type=number], textarea { width:100%; margin-top:4px; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  [aria-invalid=true] { border-color:var(--danger); outline:1px solid var(--danger); }
  .help { margin:4px 0 0; color:var(--muted); font-size:13px; }
  .badge { font-size:12px; padding:1px 8px; border-radius:999px; background:var(--chip); color:var(--muted); }
  .badge.override { color:var(--accent); }
  .error { color:var(--danger); font-size:13px; margin:4px 0 0; }
  .actions { display:flex; align-items:center; gap:12px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px; font:inherit; font-weight:600; cursor:pointer; }
  #status { color:var(--muted); }
  .tools { display:flex; align-items:center; gap:6px; }
  button.reset { background:none; color:var(--accent); border:1px solid var(--line); padding:1px 8px; font-size:12px; font-weight:500; border-radius:999px; }
  button.secondary { background:none; color:var(--text); border:1px solid var(--line); }
</style>
</head>
<body>
<main>
  <h1>Synapse settings</h1>
  <p class="lede">How readily the bot joins a conversation uninvited. Direct asks (<code>!ai</code>, <code>@synapse</code>) are always answered. Changes apply to the next message.</p>
  <section>
    <h2 id="personality-label">Personality</h2>
    <div class="presets" role="radiogroup" aria-labelledby="personality-label">
      <label><input type="radio" name="preset" value="quiet"> Quiet<small>Only answers when asked</small></label>
      <label><input type="radio" name="preset" value="normal"> Normal<small>Joins two-person disagreements</small></label>
      <label><input type="radio" name="preset" value="chatty"> Chatty<small>Jumps in easily, even for one person</small></label>
    </div>
  </section>
  <section><h2>Manual knobs</h2>${numberRows}</section>
  <section><h2>Words and names</h2>${listRows}</section>
  <div class="actions"><button type="button" id="save">Save</button><button type="button" id="reset-all" class="secondary">Reset to defaults</button><span id="status" role="status">No changes</span></div>
</main>
<script>
const PRESETS = ${JSON.stringify(PRESETS)};
const NUMBERS = ${JSON.stringify(NUMBER_FIELDS.map(([k]) => k))};
const LISTS = ${JSON.stringify(LIST_FIELDS.map(([k]) => k))};
const KEYS = [...NUMBERS, ...LISTS];
let state = null;          // last server snapshot
const edited = new Set();  // keys the user changed since loading
const cleared = new Set(); // saved overrides the user reset to the preset value (applied on Save)

const $ = (id) => document.getElementById(id);
const presetInput = (name) => document.querySelector('input[name=preset][value=' + name + ']');
const currentPreset = () => document.querySelector('input[name=preset]:checked')?.value ?? 'normal';
const pinned = (key) => edited.has(key) || (key in state.saved && !cleared.has(key)) || state.fromConfig.includes(key);

function setField(key, value) {
  $('f-' + key).value = LISTS.includes(key) ? value.join('\\n') : String(value);
}
function readField(key) {
  const raw = $('f-' + key).value;
  if (LISTS.includes(key)) return raw.split('\\n').map((s) => s.trim()).filter(Boolean);
  return raw.trim() === '' ? undefined : Number(raw);
}
function setBadge(key, source) {
  const el = document.querySelector('[data-testid="source-' + key + '"]');
  el.textContent = source;
  el.className = 'badge ' + source;
  // Values set in the config file can only be changed there.
  document.querySelector('[data-reset="' + key + '"]').hidden = source !== 'override' || state.fromConfig.includes(key);
}
function clearErrors() {
  document.querySelectorAll('.error').forEach((e) => e.remove());
  document.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
}
function showErrors(issues) {
  clearErrors();
  for (const issue of issues) {
    const field = document.querySelector('.field[data-key="' + issue.key + '"]');
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.setAttribute('role', 'alert');
    msg.textContent = (field ? field.querySelector('label').textContent : issue.key) + ' ' + issue.message;
    if (field) {
      $('f-' + issue.key).setAttribute('aria-invalid', 'true');
      field.appendChild(msg);
    } else {
      document.querySelector('.actions').before(msg);
    }
  }
}
function render(snapshot) {
  state = snapshot;
  edited.clear();
  cleared.clear();
  presetInput(snapshot.values.jump_in).checked = true;
  for (const key of KEYS) {
    setField(key, snapshot.values[key]);
    setBadge(key, snapshot.sources[key]);
  }
}

document.querySelectorAll('input[name=preset]').forEach((radio) =>
  radio.addEventListener('change', () => {
    const preset = PRESETS[currentPreset()];
    for (const key of KEYS) {
      if (pinned(key)) continue;
      setField(key, preset[key]);
      setBadge(key, 'preset');
    }
    $('status').textContent = 'Changes not applied yet';
  }),
);
document.querySelectorAll('[data-reset]').forEach((button) =>
  button.addEventListener('click', () => {
    const key = button.dataset.reset;
    edited.delete(key);
    if (key in state.saved) cleared.add(key);
    setField(key, PRESETS[currentPreset()][key]);
    setBadge(key, 'preset');
    clearErrors();
    $('status').textContent = 'Changes not applied yet';
  }),
);
for (const key of KEYS) {
  $('f-' + key).addEventListener('input', () => {
    edited.add(key);
    cleared.delete(key);
    setBadge(key, 'override');
    $('status').textContent = 'Changes not applied yet';
  });
}

$('save').addEventListener('click', async () => {
  const body = { jump_in: currentPreset() };
  for (const key of KEYS) {
    if (cleared.has(key) || (!edited.has(key) && !(key in state.saved))) continue;
    const value = readField(key);
    if (value !== undefined && !(LISTS.includes(key) && value.length === 0 && !(key in state.saved))) body[key] = value;
  }
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) {
    showErrors(json.issues ?? []);
    $('status').textContent = 'Fix the highlighted fields';
    return;
  }
  clearErrors();
  render(json);
  $('status').textContent = 'Saved';
});

$('reset-all').addEventListener('click', async () => {
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  const json = await res.json();
  if (!res.ok) {
    showErrors(json.issues ?? []);
    return;
  }
  clearErrors();
  render(json);
  $('status').textContent = 'Reset to defaults';
});

fetch('/api/settings').then((r) => r.json()).then(render);
</script>
</body>
</html>`;
}
