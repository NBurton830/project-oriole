import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';

/** specs-two V11 signed Enterprise System Invariants and verifier verdicts. */

export interface Invariant {
  id: string;
  rule: string;
}

export class InvariantSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantSignatureError';
  }
}

export const signInvariants = (invariants: Invariant[], key: string) =>
  createHmac('sha256', key).update(JSON.stringify(invariants)).digest('hex');

export function loadInvariants(path: string, key: string): Invariant[] {
  const doc = YAML.parse(fs.readFileSync(path, 'utf8')) as { invariants?: Invariant[]; signature?: string } | null;
  if (!doc?.invariants || !Array.isArray(doc.invariants)) throw new InvariantSignatureError(`${path}: no invariants`);
  if (typeof doc.signature !== 'string') throw new InvariantSignatureError(`${path}: missing signature`);
  const expected = Buffer.from(signInvariants(doc.invariants, key), 'hex');
  const actual = Buffer.from(doc.signature, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvariantSignatureError(`${path}: signature does not match; invariants may have been tampered with`);
  }
  return doc.invariants.map(({ id, rule }) => ({ id, rule }));
}

/** "PASS" → pass; "FAIL <id>" → fail with that rule; anything else fails closed. */
export function parseVerdict(text: string): { pass: true } | { pass: false; ruleId?: string } {
  const t = text.trim();
  if (/^pass\b/i.test(t)) return { pass: true };
  const fail = t.match(/^fail\b[\s:]*([A-Za-z]+-\d+)?/i);
  if (fail?.[1]) return { pass: false, ruleId: fail[1] };
  return { pass: false };
}

export const invariantWarning = (inv: Invariant) =>
  `[System Invariant Warning]: The requested consensus path violates enterprise policy rule ${inv.id} (${inv.rule}). Halting action.`;

export const VERIFIER_MARKER = '[INVARIANT_VERIFIER]';

/** System prompt for the zero-shot verifier pass. */
export function verifierPrompt(invariants: Invariant[]) {
  return [
    `${VERIFIER_MARKER} You check a chat assistant's candidate output against signed enterprise invariants.`,
    'Invariants:',
    ...invariants.map((i) => `- ${i.id}: ${i.rule}`),
    'Reply with exactly "PASS" if the candidate complies with every invariant, or "FAIL <id>" naming the first invariant it violates. Output nothing else.',
  ].join('\n');
}
