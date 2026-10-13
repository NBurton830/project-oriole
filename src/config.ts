import fs from 'node:fs';
import YAML from 'yaml';

/** Production configuration schema — specs.md §7.1. */
export interface Config {
  version: string;
  matrix: {
    homeserver_url: string;
    user_id: string;
    device_id: string;
    access_token: string;
    /** Only needed to (re)publish cross-signing keys; read from MATRIX_PASSWORD(_FILE). */
    password?: string;
    storage: { crypto_store_path: string; crypto_passphrase: string; state_store_path: string };
    verification_policy: 'strict' | 'permissive';
  };
  inference: {
    provider: string;
    base_url: string;
    api_key: string;
    model_name: string;
    parameters: {
      temperature: number;
      top_p: number;
      max_tokens: number;
      presence_penalty: number;
      frequency_penalty: number;
    };
    timeout_seconds: number;
    retry: { max_attempts: number; backoff_factor: number };
  };
  orchestration: {
    context: { max_history_events: number; token_budget: number; include_reactions: boolean };
    turn_gating: {
      deterministic_only: boolean;
      command_prefixes: string[];
      cooldown_seconds: number;
      semantic_deadlock_threshold: number;
      silence_token: string;
    };
    threading: { reply_in_thread: 'always' | 'matching' | 'auto' };
  };
  telemetry?: { metrics_port?: number };
}

/**
 * Resolves `${VAR}` from the environment. `VAR_FILE` takes precedence so secrets
 * can be mounted as files (spec §9.1).
 */
function env(name: string): string {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  const value = process.env[name];
  if (value === undefined) throw new Error(`config references \${${name}} but it is not set`);
  return value;
}

function expand(node: unknown): unknown {
  if (typeof node === 'string') return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env(name));
  if (Array.isArray(node)) return node.map(expand);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, expand(v)]));
  }
  return node;
}

export function loadConfig(path: string): Config {
  const config = expand(YAML.parse(fs.readFileSync(path, 'utf8'))) as Config;
  config.matrix.password ??= process.env.MATRIX_PASSWORD_FILE || process.env.MATRIX_PASSWORD ? env('MATRIX_PASSWORD') : undefined;
  if (process.env.SYNAPSE_METRICS_PORT) {
    config.telemetry = { ...config.telemetry, metrics_port: Number(process.env.SYNAPSE_METRICS_PORT) };
  }
  return config;
}
