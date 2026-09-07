import { delimiter } from 'node:path';

/** MAPLE_ROOTS uses the host PATH delimiter: ':' on POSIX, ';' on Windows. */
export function parseRootList(value: string | undefined, separator = delimiter): string[] {
  return (value ?? '').split(separator).filter(Boolean);
}
