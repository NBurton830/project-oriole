/** specs-two V12: does a message arriving mid-generation make the pending answer obsolete? */

const CANCEL = /\b(never ?mind|nvm|cancel that|scratch that|disregard|ignore (that|my question)|forget it)\b/i;
const RESOLVED = /\b(fixed it|found (it|the (issue|problem|bug))|resolved|solved|works now|working now|all good now|sorted it)\b/i;
const NEGATED = /\b(not|isn't|isnt|hasn't|hasnt|still not|no longer)\s+(yet\s+)?(fixed|found|resolved|solved|working|sorted)\b|\bnot\s+\w+\s+(fixed|resolved|solved)\b/i;
const HALT = /\b(stop|hold on|hold off|wait)\b/i;

export function isInvalidating(body: string, ctx: { senderPower: number; askerPower: number }): boolean {
  if (CANCEL.test(body)) return true;
  if (RESOLVED.test(body) && !NEGATED.test(body)) return true;
  return HALT.test(body) && ctx.senderPower > ctx.askerPower;
}
