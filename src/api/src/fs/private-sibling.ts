import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

/** Marks a temp the relocation can lose without losing data: a verifying copy
 * of a file that outlives it, so `sweepCrashLeftTemps` may remove one a crash
 * left behind. */
export const VERIFYING_COPY_MARKER = '.copy';

/** Marks a file a relocation took off its name for the rest of the move (a
 * Replace's kept occupant, a moved-aside sidecar). It may hold the only copy of
 * something, so a crash leaves it for `sweepCrashLeftTemps` to settle: removed
 * when its bytes live under another name, otherwise surfaced under a visible
 * name. */
export const DISPLACED_MARKER = '.keep';

const MARKERS: readonly string[] = [VERIFYING_COPY_MARKER, DISPLACED_MARKER];

const CARRIED_EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

/** The extension the short hidden form keeps, so a file recovered from it still
 * opens as what it was. One that reads as a marker is dropped: it would make
 * an unmarked name look marked. */
function carriedExtension(destination: string): string {
  const extension = path.extname(destination);
  return CARRIED_EXTENSION.test(extension) && !MARKERS.includes(extension.toLowerCase())
    ? extension
    : '';
}

/** `.tmp.` in the basename keeps `mirrored.ts` from replicating the name. A
 * destination name too long for the suffix gets a short hidden sibling instead,
 * so a long file name stays inside the 255-byte limit. */
export function privateSiblingOf(destination: string, marker = ''): string {
  const suffix = `.tmp.${process.pid}-${randomBytes(8).toString('hex')}${marker}`;
  const beside = `${destination}${suffix}`;
  return Buffer.byteLength(path.basename(beside)) <= 255
    ? beside
    : path.join(path.dirname(destination), `${suffix}${carriedExtension(destination)}`);
}

const MARKER_PATTERN = MARKERS.map((marker) => marker.replaceAll('.', '\\.')).join('|');
const BESIDE = new RegExp(`^(.+)\\.tmp\\.(\\d+)-[0-9a-f]+(${MARKER_PATTERN})?$`);
const HIDDEN = new RegExp(`^\\.tmp\\.(\\d+)-[0-9a-f]+(${MARKER_PATTERN})?(\\.[A-Za-z0-9]{1,16})?$`);

export type PrivateSiblingKind = 'verifying-copy' | 'displaced' | 'unmarked';

function kindOf(marker: string | undefined): PrivateSiblingKind {
  if (marker === VERIFYING_COPY_MARKER) return 'verifying-copy';
  return marker === DISPLACED_MARKER ? 'displaced' : 'unmarked';
}

/** The parts of a name `privateSiblingOf` produced: the name it sits beside
 * (empty for the short hidden form), the process that made it, which kind it
 * is, and the extension the short hidden form kept. */
export function parsePrivateSibling(
  name: string,
): { base: string; pid: number; kind: PrivateSiblingKind; extension: string } | null {
  const beside = BESIDE.exec(name);
  if (beside) {
    return { base: beside[1]!, pid: Number(beside[2]), kind: kindOf(beside[3]), extension: '' };
  }
  const hidden = HIDDEN.exec(name);
  return hidden
    ? { base: '', pid: Number(hidden[1]), kind: kindOf(hidden[2]), extension: hidden[3] ?? '' }
    : null;
}
