import { createHash } from 'node:crypto';
import { estimateTokens } from './context.ts';

/**
 * specs-two V6 Token Density & Entropy Gate, and table #2 staleness cutoff.
 * Oversized or high-entropy events are replaced in context by a hashed stub;
 * per-user token quotas are enforced over a rolling window.
 */

export type StubSummary = 'Error dump' | 'Encoded data' | 'Large text';

export interface GateOptions {
  maxEventTokens: number;
  entropyBitsPerChar: number;
  minEntropyLength: number;
  overridePower: number;
}

export const DEFAULT_GATE: GateOptions = { maxEventTokens: 512, entropyBitsPerChar: 4.5, minEntropyLength: 200, overridePower: 100 };

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...text].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h === 0 ? 0 : h;
}

const STACK_TRACE = /(^\s+at\s+\S+|Traceback \(most recent call last\)|\b\w+(Exception|Error)\b[:\s]|^\s*File ".*", line \d+)/m;
const ENCODED = /^[A-Za-z0-9+/=\s_-]+$/;

function summarise(body: string): StubSummary {
  if (STACK_TRACE.test(body)) return 'Error dump';
  const compact = body.replace(/\s+/g, '');
  if (compact.length >= 64 && ENCODED.test(body) && !/\s\w+\s\w+\s/.test(body)) return 'Encoded data';
  return 'Large text';
}

export function gateEvent(
  event: { sender: string; body: string; power: number },
  opts: Partial<GateOptions> = {},
): { kind: 'pass' } | { kind: 'stub'; stub: string; sha256: string; summary: StubSummary } {
  const o = { ...DEFAULT_GATE, ...opts };
  if (event.power >= o.overridePower) return { kind: 'pass' };
  const tooLong = estimateTokens(event.body) > o.maxEventTokens;
  const tooDense = event.body.length >= o.minEntropyLength && shannonEntropy(event.body) > o.entropyBitsPerChar;
  if (!tooLong && !tooDense) return { kind: 'pass' };
  const sha256 = createHash('sha256').update(event.body, 'utf8').digest('hex');
  const summary = summarise(event.body);
  return { kind: 'stub', sha256, summary, stub: `[High-volume event from ${event.sender} truncated: Hash SHA256(${sha256}) - Summary: ${summary}]` };
}

/** Per-user token quota over a rolling window; refused requests are not recorded. */
export class TokenQuota {
  private readonly tokensPerWindow: number;
  private readonly windowMs: number;
  private readonly usage = new Map<string, Array<{ at: number; tokens: number }>>();

  constructor(opts: { tokensPerWindow: number; windowMs?: number }) {
    this.tokensPerWindow = opts.tokensPerWindow;
    this.windowMs = opts.windowMs ?? 60_000;
  }

  admit(sender: string, tokens: number, now = Date.now()): boolean {
    const recent = (this.usage.get(sender) ?? []).filter((u) => now - u.at < this.windowMs);
    const used = recent.reduce((sum, u) => sum + u.tokens, 0);
    if (used + tokens > this.tokensPerWindow) {
      this.usage.set(sender, recent);
      return false;
    }
    recent.push({ at: now, tokens });
    this.usage.set(sender, recent);
    return true;
  }
}

/** Table #2: an event is stale when its origin timestamp is more than `staleAfterSeconds` in the past. */
export function isStale(originTs: number, now: number, staleAfterSeconds = 120): boolean {
  return now - originTs > staleAfterSeconds * 1000;
}
