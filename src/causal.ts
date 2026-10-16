/**
 * specs-two V10 causal linearizer: events are released only after every
 * prev_event is known, in ancestry order (ties by timestamp). Events whose
 * ancestry stays unresolved past the jitter window are released as ambiguous.
 */

export interface CausalEvent {
  eventId: string;
  prevEvents: string[];
  ts: number;
}

export class CausalLinearizer {
  private readonly jitterMs: number;
  private readonly known = new Set<string>();
  private readonly ambiguousIds = new Set<string>();
  private pending: Array<{ event: CausalEvent; arrivedAt: number }> = [];

  constructor(opts: { jitterMs?: number } = {}) {
    this.jitterMs = opts.jitterMs ?? 1500;
  }

  markKnown(eventId: string) {
    this.known.add(eventId);
  }

  add(event: CausalEvent, now: number) {
    this.pending.push({ event, arrivedAt: now });
  }

  drain(now: number): { ordered: CausalEvent[]; ambiguous: CausalEvent[] } {
    const ordered: CausalEvent[] = [];
    const ambiguous: CausalEvent[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      const ready = this.pending
        .filter(({ event }) => event.prevEvents.every((p) => this.known.has(p)))
        .sort((a, b) => a.event.ts - b.event.ts);
      if (ready.length) {
        const next = ready[0];
        this.pending = this.pending.filter((p) => p !== next);
        this.known.add(next.event.eventId);
        ordered.push(next.event);
        progress = true;
      }
    }
    // Anything still waiting past the jitter window, or descending from an ambiguous event, is ambiguous.
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of [...this.pending]) {
        const timedOut = now - p.arrivedAt > this.jitterMs;
        const taintedParent = p.event.prevEvents.some((id) => this.ambiguousIds.has(id));
        if (timedOut || taintedParent) {
          this.pending = this.pending.filter((x) => x !== p);
          this.ambiguousIds.add(p.event.eventId);
          ambiguous.push(p.event);
          changed = true;
        }
      }
    }
    return { ordered, ambiguous };
  }
}
