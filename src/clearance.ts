/**
 * specs-two V7 Lowest-Common-Denominator Room Clearance: what the bot may say
 * in a room is limited to what every joined member is cleared to see.
 */

export interface DirectoryEntry {
  match: string;
  role?: string;
  acl_role?: string;
  clearances?: string[];
}

export interface KnowledgeDoc {
  id: string;
  clearance?: string;
  keywords: string[];
  text: string;
}

const patternCache = new Map<string, RegExp>();
const pattern = (p: string) => {
  let re = patternCache.get(p);
  if (!re) patternCache.set(p, (re = new RegExp(p)));
  return re;
};

export function lookupPerson(userId: string, directory: DirectoryEntry[] = []) {
  const row = directory.find((d) => pattern(d.match).test(userId));
  return { role: row?.role, acl_role: row?.acl_role, clearances: [...(row?.clearances ?? [])] };
}

export function roomClearance(memberIds: string[], directory: DirectoryEntry[] = []): Set<string> {
  if (memberIds.length === 0) return new Set();
  const [first, ...rest] = memberIds.map((id) => new Set(lookupPerson(id, directory).clearances));
  return new Set([...first].filter((c) => rest.every((s) => s.has(c))));
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);

export function retrieve(query: string, docs: KnowledgeDoc[], allowed: Set<string>): KnowledgeDoc[] {
  const q = words(query);
  return docs.filter((d) => d.keywords.some((k) => q.has(k.toLowerCase())) && (d.clearance === undefined || allowed.has(d.clearance)));
}

export function planDisclosure(query: string, docs: KnowledgeDoc[], roomScope: Set<string>, initiatorScope: Set<string>) {
  const inRoom = retrieve(query, docs, roomScope);
  const privateOnly = retrieve(query, docs, initiatorScope).filter((d) => !inRoom.includes(d));
  return { inRoom, privateOnly };
}
