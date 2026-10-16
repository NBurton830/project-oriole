/** specs-two V19 Pragmatic Affect & Tone Normalizer. */

const NEGATIVE = /\b(down|broken|failing|failed|fail|disaster|outage|fire|screaming|unacceptable|crash|crashed|panic|urgent|asap|now|why|who|wtf|help|nothing|worst|furious)\b/i;

interface Turn {
  body: string;
  fromBot: boolean;
}

/** Share of recent human messages showing stress, weighted by how many signals each carries. */
export function stressIndex(history: Turn[], window = 8): number {
  const recent = history.filter((t) => !t.fromBot).slice(-window);
  if (!recent.length) return 0;
  const score = (body: string) => {
    const letters = body.replace(/[^A-Za-z]/g, '');
    const upper = letters.replace(/[^A-Z]/g, '').length;
    const signals = [
      /!{2,}|\?{2,}|[!?]{2,}/.test(body), // punctuation clustering
      letters.length >= 4 && upper / letters.length > 0.6, // shouting
      NEGATIVE.test(body), // negative polarity
    ].filter(Boolean).length;
    return Math.min(1, signals / 2);
  };
  return recent.reduce((sum, t) => sum + score(t.body), 0) / recent.length;
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;
const FLUFF_SENTENCE =
  /^(hi|hello|hey|good (morning|afternoon|evening))\b[^.!?]*[.!?]?$|^(happy|glad) to help\b|^great question\b|^(sorry|apologies|my apologies|i apologi[sz]e|i'm sorry|i am sorry)\b|^(no problem|of course|certainly|sure thing|absolutely)\b[.!]?$|^(thanks|thank you)\b|^hope (this|that) helps\b/i;

/** Strips emojis, greetings, pleasantries and apologies; keeps operational content. */
export function normalizeTone(text: string): string {
  const noEmoji = text.replace(EMOJI, '').replace(/[ \t]+/g, ' ').trim();
  const sentences = noEmoji.match(/[^.!?]+[.!?]*\s*/g) ?? [noEmoji];
  const kept = sentences.filter((s) => !FLUFF_SENTENCE.test(s.trim()));
  return kept.join('').trim();
}

export const CRITICAL_DEMEANOR_MARKER = 'Critical Operational Demeanor Protocol';
