import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

/** Marks a temp the relocation can lose without losing data: a verifying copy
 * of a file that outlives it, so `sweepCrashLeftTemps` may remove one a crash
 * left behind. Every other private sibling (a displaced photo, a moved-aside
 * file) may hold the only copy of something and is never swept. */
export const VERIFYING_COPY_MARKER = '.copy';

/** `.tmp.` in the basename keeps `mirrored.ts` from replicating the name. A
 * destination name too long for the suffix gets a short hidden sibling instead,
 * so a long file name stays inside the 255-byte limit. */
export function privateSiblingOf(destination: string, marker = ''): string {
  const suffix = `.tmp.${process.pid}-${randomBytes(8).toString('hex')}${marker}`;
  const beside = `${destination}${suffix}`;
  return Buffer.byteLength(path.basename(beside)) <= 255
    ? beside
    : path.join(path.dirname(destination), suffix);
}

const PRIVATE_SIBLING = new RegExp(
  `^(.*)\\.tmp\\.(\\d+)-[0-9a-f]+(${VERIFYING_COPY_MARKER.replaceAll('.', '\\.')})?$`,
);

/** The parts of a name `privateSiblingOf` produced: the name it sits beside
 * (empty for the short hidden form), the process that made it, and whether it
 * is a verifying copy. */
export function parsePrivateSibling(
  name: string,
): { base: string; pid: number; verifyingCopy: boolean } | null {
  const match = PRIVATE_SIBLING.exec(name);
  return match
    ? { base: match[1] ?? '', pid: Number(match[2]), verifyingCopy: match[3] !== undefined }
    : null;
}
