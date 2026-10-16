/** specs-two table #1: delimiter stripping and instruction-override detection. */

const TEMPLATE_TOKENS = /<\|[a-z_]+\|>|\[\/?INST\]|\[\/?SYSTEM\]|<<\/?SYS>>/gi;
const FRAME_TAGS = /<(\/?)(speaker|system_summary|knowledge|system)\b([^>]*)>/gi;

export function sanitizeForPrompt(body: string): string {
  return body
    .replace(TEMPLATE_TOKENS, (t) => `(${t.replace(/[<>|[\]]/g, '').trim()})`)
    .replace(FRAME_TAGS, (_m, slash: string, tag: string, rest: string) => `&lt;${slash}${tag}${rest}&gt;`);
}

const OVERRIDE = /\b(ignore (all )?(the )?(previous|prior|above) (instructions|rules|prompts?)|you are now\b|system prompt\s*:|new rules\s*:|disregard (all )?(previous|prior) (instructions|rules))/i;

export const looksLikeInjection = (body: string) => OVERRIDE.test(body);
