/**
 * Compare-and-swap publish for a backup sidecar re-send (#4719).
 *
 * The device names the sidecar version its edit was based on (`base`, the
 * SHA-256 of the XMP it last delivered, or `null` for none). Under the shared
 * sidecar write barrier:
 *   - nothing on disk yet → create it;
 *   - the server already holds exactly this XMP → leave it alone;
 *   - the server still holds the base version → overwrite it;
 *   - anything else is a divergence → keep the displaced XMP (via `recordDisplaced`,
 *     before publishing, so a failed publish can never lose it) and land the
 *     incoming edit on top.
 */
import { createHash } from 'node:crypto';
import {
  isMissingSidecar,
  readSidecarNoFollow,
  writeSidecarAtomic,
  writeSidecarCreateOnly,
} from '../fs/sidecar-io.ts';
import { serializeSidecarWrite } from '../fs/sidecar-write-order.ts';

type SidecarCasOutcome =
  | { kind: 'written' }
  | { kind: 'unchanged' }
  | { kind: 'diverged' }
  | { kind: 'error'; error: string };

interface DisplacedSidecar {
  xmp: string;
  sha256: string;
  incomingSha256: string;
}

const sidecarSha256 = (xmp: string): string =>
  createHash('sha256').update(xmp, 'utf8').digest('hex');

async function readCurrent(destination: string): Promise<string | null> {
  try {
    return await readSidecarNoFollow(destination);
  } catch (error) {
    if (isMissingSidecar(error)) return null;
    throw error;
  }
}

export async function publishSidecarCas(
  destination: string,
  xmp: string,
  base: string | null,
  recordDisplaced: (displaced: DisplacedSidecar) => Promise<void>,
  admissionScope: string,
): Promise<SidecarCasOutcome> {
  return serializeSidecarWrite<SidecarCasOutcome>(
    destination,
    async (resolved) => {
      const existing = await readCurrent(resolved);
      if (existing === null) {
        const created = await writeSidecarCreateOnly(resolved, xmp, 'sidecar write failed');
        if (created.ok) return { kind: 'written' };
        if (!('exists' in created)) return { kind: 'error', error: created.error };
      }
      // A writer outside the barrier can create the file between the read and
      // the create-only publish; compare against what is actually there.
      const current = existing ?? (await readCurrent(resolved));
      if (current === null) return { kind: 'error', error: 'sidecar vanished during write' };

      const incomingSha256 = sidecarSha256(xmp);
      const currentSha256 = sidecarSha256(current);
      if (currentSha256 === incomingSha256) return { kind: 'unchanged' };
      const diverged = currentSha256 !== base;
      if (diverged) await recordDisplaced({ xmp: current, sha256: currentSha256, incomingSha256 });
      const written = await writeSidecarAtomic(resolved, xmp, 'sidecar write failed');
      if (!written.ok) return { kind: 'error', error: written.error };
      return { kind: diverged ? 'diverged' : 'written' };
    },
    { admissionScope },
  );
}
