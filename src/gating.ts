import type { HistoryEntry } from './context.ts';
import type { JumpInSettings } from './settings.ts';

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
  /** Informal names that call the bot when they are the first word of a message. */
  nicknames?: string[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Letters, digits or underscore in any script: what "inside a word" means for custom words. */
const WORD_CHAR = '[\\p{L}\\p{N}_]';

/** Case-insensitive whole-word / whole-phrase pattern; spaces in a phrase match any whitespace. */
function wordPattern(word: string, anchorStart = false) {
  const body = word.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`${anchorStart ? '^' : `(?<!${WORD_CHAR})`}${body}(?!${WORD_CHAR})`, 'iu');
}

const anyWord = (words: string[]) => {
  const patterns = words.map((w) => wordPattern(w));
  return (text: string) => patterns.some((p) => p.test(text));
};

/** Tier 1: mention (MXID, m.mentions, or display name), reply-to-bot, or command prefix. */
export function tier1Matches(input: Tier1Input, bot: BotIdentity): boolean {
  const body = input.body.trim();
  if (input.mentionedUserIds.includes(bot.userId)) return true;
  if (body.includes(bot.userId)) return true;
  if (bot.displayName && new RegExp(`(^|[^\\w])@?${escapeRegExp(bot.displayName)}(?![\\w])`, 'i').test(body)) return true;
  if (input.inReplyTo && !input.isFallbackReply && bot.authored.has(input.inReplyTo)) return true;
  if (bot.nicknames?.some((nick) => wordPattern(nick, true).test(body))) return true;
  const lower = body.toLowerCase();
  return bot.commandPrefixes.some((p) => lower === p.toLowerCase() || lower.startsWith(`${p.toLowerCase()} `));
}

export const QUESTION = /\?/;
export const NEGATIVE =
  /\b(no|nope|nah|not|disagree|risky|risk|bad|badly|wrong|incorrect|never|can't|cannot|won't|don't|doesn't|isn't|blocker|problem|concern|worried|hate|ugly|boring|overrated|worse|worst)\b/i;
/** Competing opinions often carry no question or negation: "Blue is the best." / "Red is way better." */
export const STANCE = /\b(better|best|prefer|preferred|favou?rite|superior|actually|obviously|clearly|instead|rather|wins?)\b/i;
export const CONSENSUS =
  /\b(agreed|agree with you|i agree|sounds good|deal|settled|let's do (it|that)|works for me|lgtm|makes sense|you're right|fair point)\b/i;

/**
 * Tier-2 structural check (spec §6.2): may the agent consider jumping in?
 *  - jumping in is enabled (not the quiet preset);
 *  - the last `window_size` messages are all human (the bot never argues with itself);
 *  - at least `min_speakers` different people wrote them;
 *  - the latest message is not agreement (built-in or custom words);
 *  - the share showing friction (questions, negative polarity, competing stances,
 *    or custom words) meets `semantic_deadlock_threshold`.
 * Timing (cooldown, patience, typing) is handled by the agent.
 */
export function shouldJumpIn(history: HistoryEntry[], settings: JumpInSettings): boolean {
  return jumpInDecision(history, settings).join;
}

/** Same check as `shouldJumpIn`, with a plain-English reason for the activity log. */
export function jumpInDecision(history: HistoryEntry[], settings: JumpInSettings): { join: boolean; reason: string } {
  const no = (reason: string) => ({ join: false, reason });
  if (!settings.enabled) return no('quiet mode');
  const recent = history.slice(-settings.window_size);
  if (recent.length < settings.window_size) return no(`only ${recent.length} of ${settings.window_size} messages so far`);
  if (recent.some((e) => e.fromBot)) return no(`bot spoke within the last ${settings.window_size} messages`);
  const people = new Set(recent.map((e) => e.sender)).size;
  if (people < settings.min_speakers) return no(`only ${people} of ${settings.min_speakers} people`);

  const customConsensus = anyWord(settings.consensus_words);
  const last = recent[recent.length - 1].body;
  if (CONSENSUS.test(last) || customConsensus(last)) return no('latest message is agreement');

  const customFriction = anyWord(settings.friction_words);
  const friction = recent.filter(
    (e) => QUESTION.test(e.body) || NEGATIVE.test(e.body) || STANCE.test(e.body) || customFriction(e.body),
  ).length;
  const share = `${friction} of ${recent.length} messages heated`;
  return friction / recent.length >= settings.semantic_deadlock_threshold
    ? { join: true, reason: share }
    : no(`${share}, needs ${settings.semantic_deadlock_threshold}`);
}

/** Built-in friction check: question, negative polarity or a competing stance. */
export const isHeated = (body: string) => QUESTION.test(body) || NEGATIVE.test(body) || STANCE.test(body);

/** Strict negative-constraint check (spec §6.2): whitespace-trimmed exact match. */
export const isSilence = (output: string, token: string) => output.trim() === token;
