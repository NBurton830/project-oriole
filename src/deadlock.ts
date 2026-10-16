import { CONSENSUS, isHeated } from './gating.ts';

/** specs-two V15 Epistemic Entropy & Deadlock Detector. */

interface Turn {
  sender: string;
  body: string;
  fromBot: boolean;
}

export function speakerEntropy(history: Turn[], n = 8): number {
  const recent = history.slice(-n);
  if (!recent.length) return 0;
  const counts = new Map<string, number>();
  for (const t of recent) counts.set(t.sender, (counts.get(t.sender) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / recent.length;
    h -= p * Math.log2(p);
  }
  return h === 0 ? 0 : h;
}

export function isProductiveDeadlock(history: Turn[], opts: { minTurns?: number; minEntropy?: number } = {}): boolean {
  const minTurns = opts.minTurns ?? 8;
  const recent = history.slice(-minTurns);
  if (recent.length < minTurns || recent.some((t) => t.fromBot)) return false;
  if (new Set(recent.map((t) => t.sender)).size < 2) return false;
  if (recent.some((t) => CONSENSUS.test(t.body))) return false;
  if (speakerEntropy(recent, minTurns) < (opts.minEntropy ?? 0.9)) return false;
  return recent.filter((t) => isHeated(t.body)).length / recent.length >= 0.5;
}

export function highestRankedStakeholder(members: Array<{ userId: string; power: number }>, botId: string): string | undefined {
  let best: { userId: string; power: number } | undefined;
  for (const m of members) if (m.userId !== botId && (!best || m.power > best.power)) best = m;
  return best?.userId;
}

export const NEUTRAL_SYNTHESIS_MARKER = 'Neutral Synthesis Intervention';
