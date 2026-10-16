/**
 * Jump-in settings: how readily the agent joins a conversation uninvited
 * (spec §6.2). Values come from a preset, then explicit values (config file,
 * then dashboard overrides). Direct asks (Tier 1) are never affected.
 */

export type Preset = 'quiet' | 'normal' | 'chatty';

export interface JumpInSettings {
  jump_in: Preset;
  /** false = never jump in uninvited. */
  enabled: boolean;
  window_size: number;
  min_speakers: number;
  semantic_deadlock_threshold: number;
  cooldown_seconds: number;
  settle_seconds: number;
  friction_words: string[];
  consensus_words: string[];
  nicknames: string[];
}

export type SettingKey = keyof JumpInSettings;
export type Source = 'preset' | 'override';

export interface ResolvedSettings {
  values: JumpInSettings;
  sources: Record<SettingKey, Source>;
}

export interface SettingsIssue {
  key: string;
  message: string;
}

export class SettingsError extends Error {
  readonly issues: SettingsIssue[];
  constructor(issues: SettingsIssue[]) {
    super(`Invalid jump-in settings: ${issues.map((i) => `${i.key} ${i.message}`).join('; ')}`);
    this.issues = issues;
    this.name = 'SettingsError';
  }
}

const NORMAL: Omit<JumpInSettings, 'jump_in' | 'enabled'> = {
  window_size: 4,
  min_speakers: 2,
  semantic_deadlock_threshold: 0.75,
  cooldown_seconds: 45,
  settle_seconds: 1.5,
  friction_words: [],
  consensus_words: [],
  nicknames: [],
};

export const PRESETS: Record<Preset, JumpInSettings> = {
  quiet: { ...NORMAL, jump_in: 'quiet', enabled: false },
  normal: { ...NORMAL, jump_in: 'normal', enabled: true },
  chatty: { ...NORMAL, jump_in: 'chatty', enabled: true, min_speakers: 1, semantic_deadlock_threshold: 0.5, cooldown_seconds: 15 },
};

/** Keys a user may set for jump-in behaviour (config file or dashboard). */
export const JUMP_IN_KEYS = [
  'jump_in',
  'window_size',
  'min_speakers',
  'semantic_deadlock_threshold',
  'cooldown_seconds',
  'settle_seconds',
  'friction_words',
  'consensus_words',
  'nicknames',
] as const;

/** Other `turn_gating` keys that are valid but not jump-in settings. */
const OTHER_TURN_GATING_KEYS = ['deterministic_only', 'command_prefixes', 'silence_token'];

type Check = (value: unknown) => string | undefined;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const wholeAtLeast = (min: number, why = ''): Check => (v) =>
  isNumber(v) && Number.isInteger(v) && v >= min ? undefined : `must be a whole number of at least ${min}${why}`;
const nonNegative: Check = (v) => (isNumber(v) && v >= 0 ? undefined : 'must be a number, 0 or more (not negative)');
const wordList: Check = (v) =>
  Array.isArray(v) && v.every((w) => typeof w === 'string' && w.trim() !== '')
    ? undefined
    : 'must be a list of non-empty words or phrases';

const CHECKS: Record<string, Check> = {
  jump_in: (v) => (typeof v === 'string' && v in PRESETS ? undefined : 'must be one of quiet, normal, chatty'),
  window_size: wholeAtLeast(4, ' (the spec requires looking at 4 or more messages)'),
  min_speakers: wholeAtLeast(1),
  semantic_deadlock_threshold: (v) => (isNumber(v) && v > 0 && v <= 1 ? undefined : 'must be a number above 0 and at most 1'),
  cooldown_seconds: nonNegative,
  settle_seconds: nonNegative,
  friction_words: wordList,
  consensus_words: wordList,
  nicknames: wordList,
  deterministic_only: (v) => (typeof v === 'boolean' ? undefined : 'must be true or false'),
  command_prefixes: wordList,
  silence_token: (v) => (typeof v === 'string' && v.trim() !== '' ? undefined : 'must be a non-empty string'),
};

/** Returns every problem with `input`; an empty list means it is valid. */
export function validateJumpInSettings(input: Record<string, unknown>, allowed: readonly string[] = [...JUMP_IN_KEYS, ...OTHER_TURN_GATING_KEYS]) {
  const issues: SettingsIssue[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key)) {
      issues.push({ key, message: 'is not a known setting' });
      continue;
    }
    const problem = CHECKS[key]?.(value);
    if (problem) issues.push({ key, message: problem });
  }
  return issues;
}

/** Resolves a `turn_gating`-shaped object; throws `SettingsError` listing every problem. */
export function resolveJumpInSettings(input: Record<string, unknown>): ResolvedSettings {
  const issues = validateJumpInSettings(input);
  if (issues.length) throw new SettingsError(issues);

  const legacyQuiet = input.deterministic_only === true;
  const preset = (input.jump_in as Preset | undefined) ?? (legacyQuiet ? 'quiet' : 'normal');
  const values = structuredClone(PRESETS[preset]);
  const sources = Object.fromEntries(Object.keys(values).map((k) => [k, 'preset'])) as Record<SettingKey, Source>;

  for (const key of JUMP_IN_KEYS) {
    if (input[key] === undefined) continue;
    (values as unknown as Record<string, unknown>)[key] = structuredClone(input[key]);
    sources[key] = 'override';
  }
  if (legacyQuiet) {
    values.enabled = false;
    sources.enabled = 'override';
  }
  return { values, sources };
}
