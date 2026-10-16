import { lookupPerson, type DirectoryEntry } from './clearance.ts';

/** specs-two V20 Immutable Cryptographic Identity Matrix. */

export interface Member {
  userId: string;
  displayName: string;
  power: number;
}

export function identityToken(userId: string, directory: DirectoryEntry[] = []): string {
  return `[USER_ID: ${userId} | ACL_ROLE: ${lookupPerson(userId, directory).acl_role ?? 'NONE'}]`;
}

/** Case, whitespace, diacritics and a trailing parenthetical are ignored. */
export const normalizeName = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function detectImpersonation(member: Member, others: Member[]): { suspect: true; impersonated: string } | { suspect: false } {
  const name = normalizeName(member.displayName);
  if (!name) return { suspect: false };
  const victim = others.find((o) => o.userId !== member.userId && o.power > member.power && normalizeName(o.displayName) === name);
  return victim ? { suspect: true, impersonated: victim.userId } : { suspect: false };
}
