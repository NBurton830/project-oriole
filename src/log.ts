import { format } from 'node:util';

/** Operational logging. Never pass message bodies here — plaintext stays in RAM (spec §8.5). */
const write = (level: string) => (msg: string, ...args: unknown[]): void => {
  process.stderr.write(`${new Date().toISOString()} ${level} ${format(msg, ...args)}\n`);
};

export const log = {
  debug: process.env.SYNAPSE_DEBUG ? write('DEBUG') : () => {},
  info: write('INFO '),
  warn: write('WARN '),
  error: write('ERROR'),
};
