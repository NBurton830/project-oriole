import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.ts';

/**
 * Decision log: one readable line per thing the bot decided and why.
 *
 * Message text never reaches this file (spec §8.5: plaintext stays in RAM).
 * The field type only accepts identifiers, names, numbers, booleans and the
 * fixed reason strings the agent supplies — callers must never pass a body,
 * a prompt or a model reply.
 *
 *   2026-10-14 13:05:22.123  not-joining  room="Test" (!abc:test.local)  reason="only 1 of 2 people"
 *
 * Files: <dir>/synapse-YYYY-MM-DD.log (local date), deleted after `retentionDays`.
 */

export type ActivityEvent =
  | 'started'
  | 'stopped'
  | 'settings-changed'
  | 'joined-room'
  | 'ignored'
  | 'key-timeout'
  | 'direct-ask'
  | 'waiting'
  | 'not-joining'
  | 'joining'
  | 'replied'
  | 'stayed-silent'
  | 'failed'
  | 'inference-retry'
  | 'circuit-open'
  | 'circuit-closed'
  | 'dead-letter'
  | 'aborted'
  | 'impersonation'
  | 'private-reply'
  | 'invariant-blocked'
  | 'tool-executed'
  | 'tool-duplicate'
  | 'tool-staged'
  | 'tool-rejected'
  | 'tool-cancelled';

export type ActivityFields = Record<string, string | number | boolean | undefined>;

export interface ActivityLogOptions {
  dir: string;
  retentionDays: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

const FILE = /^synapse-(\d{4})-(\d{2})-(\d{2})\.log$/;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

function formatValue(value: string | number | boolean) {
  if (typeof value !== 'string') return String(value);
  // Quote anything with spaces/quotes; keep one record per line.
  const clean = value.replace(/[\r\n]+/g, ' ');
  return /^[\w@!$:.\-+/]+$/.test(clean) ? clean : JSON.stringify(clean);
}

export class ActivityLog {
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private lastPrunedDay = '';

  constructor(opts: ActivityLogOptions) {
    if (!Number.isInteger(opts.retentionDays) || opts.retentionDays < 1) {
      throw new Error('activity log retention_days must be a whole number of at least 1');
    }
    this.dir = opts.dir;
    this.retentionDays = opts.retentionDays;
    this.now = opts.now ?? (() => new Date());
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Path of today's file. */
  get currentFile() {
    return path.join(this.dir, `synapse-${localDate(this.now())}.log`);
  }

  record(event: ActivityEvent, fields: ActivityFields = {}) {
    const at = this.now();
    const day = localDate(at);
    if (day !== this.lastPrunedDay) {
      this.lastPrunedDay = day;
      try {
        this.prune();
      } catch (err) {
        log.warn('activity log cleanup failed: %s', (err as Error).message);
      }
    }
    const parts = Object.entries(fields)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== '')
      .map(([k, v]) => `${k}=${formatValue(v)}`);
    const line = `${day} ${localTime(at)}  ${event.padEnd(16)} ${parts.join('  ')}`.trimEnd() + '\n';
    try {
      fs.appendFileSync(path.join(this.dir, `synapse-${day}.log`), line, { mode: 0o600 });
    } catch (err) {
      log.warn('activity log write failed: %s', (err as Error).message);
    }
  }

  /** Deletes log files whose date is older than the retention period. */
  prune() {
    const cutoff = new Date(this.now());
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (this.retentionDays - 1));
    for (const name of fs.readdirSync(this.dir)) {
      const m = name.match(FILE);
      if (!m) continue;
      const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (fileDay < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

/** Process-wide log; a no-op until `configureActivityLog` is called. */
let current: ActivityLog | undefined;

export function configureActivityLog(opts: ActivityLogOptions | undefined) {
  current = opts ? new ActivityLog(opts) : undefined;
  return current;
}

export function activity(event: ActivityEvent, fields?: ActivityFields) {
  current?.record(event, fields);
}
