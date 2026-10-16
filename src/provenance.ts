/** specs-two V14 Cryptographic Chain of Provenance: delegation claims need an in-room confirmation. */

export interface Member {
  userId: string;
  displayName: string;
  power: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names a member can be referred to by: MXID, full display name, display name without a parenthetical, first name. */
function aliases(m: Member): string[] {
  const base = m.displayName.replace(/\s*\(.*\)\s*$/, '').trim();
  const first = base.split(/\s+/)[0];
  return [...new Set([m.userId, m.displayName, base, first].filter((a) => a && a.length >= 2))].sort((a, b) => b.length - a.length);
}

const CLAIM_AFTER = String.raw`(?:,?\s*\([^)]*\))?,?\s+(?:\w+\s+){0,2}?(?:told me|said (?:that )?(?:you|i|we)\b|asked me|wants me|approved|authori[sz]ed|signed off|okayed|ok'd)`;

export function detectDelegationClaim(body: string, members: Member[]): { claimedAuthority: string } | null {
  for (const m of members) {
    for (const alias of aliases(m)) {
      const name = `(?<![\\w@])@?${escape(alias)}(?![\\w])`;
      const direct = new RegExp(`${name}${CLAIM_AFTER}`, 'i');
      const behalf = new RegExp(`on behalf of\\s+${name}`, 'i');
      if (direct.test(body) || behalf.test(body)) return { claimedAuthority: m.userId };
    }
  }
  return null;
}

const APPROVING = /\b(approve|approved|yes|go ahead|confirmed|confirm)\b/i;

export function hasVerifiedApproval(
  authority: string,
  requestEventId: string,
  events: Array<{ sender: string; type: string; content: Record<string, any> }>,
): boolean {
  return events.some((e) => {
    if (e.sender !== authority) return false;
    const rel = e.content?.['m.relates_to'];
    if (e.type === 'm.reaction') return rel?.rel_type === 'm.annotation' && rel?.event_id === requestEventId && rel?.key === '✅';
    if (e.type === 'm.room.message') return rel?.['m.in_reply_to']?.event_id === requestEventId && APPROVING.test(String(e.content.body ?? ''));
    return false;
  });
}

export const provenanceRejection = (authority: string) =>
  `Cannot execute: Request requires verified Matrix event confirmation from ${authority}. Identity claim unverified.`;
