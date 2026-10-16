import { createHmac } from 'node:crypto';

/** specs-two V9 Idempotency Key & lock protocol for tool execution. */

export function idempotencyKey(input: { tool: string; target: string; timestamp: number }, secret: string, bucketSeconds = 60): string {
  const bucket = Math.floor(input.timestamp / 1000 / bucketSeconds);
  return createHmac('sha256', secret)
    .update(`${input.tool}‖${input.target.trim().toLowerCase()}‖${bucket}`)
    .digest('hex');
}

interface LedgerEntry {
  eventId: string;
  sender: string;
  claimedAt: number;
  result?: string;
}

/** In-flight and committed operations by idempotency key. Keys embed their time bucket, so entries expire naturally. */
export class ToolLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  claim(key: string, request: { eventId: string; sender: string }): { status: 'new' } | { status: 'duplicate'; original: { eventId: string; sender: string } } {
    const existing = this.entries.get(key);
    if (existing) return { status: 'duplicate', original: { eventId: existing.eventId, sender: existing.sender } };
    this.entries.set(key, { ...request, claimedAt: Date.now() });
    if (this.entries.size > 10_000) this.entries.delete(this.entries.keys().next().value!);
    return { status: 'new' };
  }

  complete(key: string, result: string) {
    const e = this.entries.get(key);
    if (e) e.result = result;
  }

  /** Releases a claim whose execution failed, so a retry can run. */
  release(key: string) {
    this.entries.delete(key);
  }

  resultOf(key: string) {
    return this.entries.get(key)?.result;
  }

  /** When `key` was claimed, if it is held. */
  claimedAt(key: string) {
    return this.entries.get(key)?.claimedAt;
  }
}
