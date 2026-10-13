import type { HistoryEntry } from './context.ts';

/** Two-tier turn gating — specs.md §6. */

export interface Tier1Input {
  body: string;
  mentionedUserIds: string[];
  inReplyTo?: string;
  isFallbackReply: boolean;
}

export interface BotIdentity {
  userId: string;
  displayName: string;
  /** Event IDs authored by the bot in this room. */
  authored: Set<string>;
  commandPrefixes: string[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Tier 1: mention (MXID, m.mentions, or display name), reply-to-bot, or command prefix. */
export function tier1Matches(input: Tier1Input, bot: BotIdentity): boolean {
  const body = input.body.trim();
  if (input.mentionedUserIds.includes(bot.userId)) return true;
  if (body.includes(bot.userId)) return true;
  if (bot.displayName && new RegExp(`(^|[^\\w])@?${escapeRegExp(bot.displayName)}(?![\\w])`, 'i').test(body)) return true;
  if (input.inReplyTo && !input.isFallbackReply && bot.authored.has(input.inReplyTo)) return true;
  const lower = body.toLowerCase();
  return bot.commandPrefixes.some((p) => lower === p.toLowerCase() || lower.startsWith(`${p.toLowerCase()} `));
}

const QUESTION = /\?/;
const NEGATIVE = /\b(no|not|disagree|risky|risk|bad|badly|wrong|never|can't|cannot|won't|don't|doesn't|isn't|blocker|problem|concern|worried)\b/i;
const CONSENSUS = /\b(agreed|agree with you|sounds good|deal|settled|let's do (it|that)|works for me|lgtm|makes sense)\b/i;

/**
 * Deadlock / intervention heuristic: the last `window` messages are all human,
 * involve at least two speakers, the share carrying open questions or negative
 * polarity meets `threshold`, and the latest message is not a consensus marker.
 */
export function deadlockDetected(history: HistoryEntry[], window: number, threshold: number): boolean {
  const recent = history.slice(-window);
  if (recent.length < window || recent.some((e) => e.fromBot)) return false;
  if (new Set(recent.map((e) => e.sender)).size < 2) return false;
  if (CONSENSUS.test(recent[recent.length - 1].body)) return false;
  const friction = recent.filter((e) => QUESTION.test(e.body) || NEGATIVE.test(e.body)).length;
  return friction / recent.length >= threshold;
}

/** Strict negative-constraint check (spec §6.2): whitespace-trimmed exact match. */
export const isSilence = (output: string, token: string) => output.trim() === token;
