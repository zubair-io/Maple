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
 *     incoming edit on top;
 *   - except when a same-stem sibling shares the sidecar (#4692): then only the
 *     named base may be replaced, and any other incoming edit is kept aside
 *     instead, so one photo never overwrites the other's edits.
 */
import { createHash } from 'node:crypto';
import {
  authorizeSidecarWrite,
  isMissingSidecar,
  readSidecarNoFollow,
  writeSidecarAtomic,
  writeSidecarCreateOnly,
} from '../fs/sidecar-io.ts';
import { serializeSidecarWrite } from '../fs/sidecar-write-order.ts';
// Mirror-aware drop-in, so the sidecar's directory replicates with it.
import fs from '../fs/mirrored.ts';
import path from 'node:path';

type SidecarCasOutcome =
  | { kind: 'written' }
  | { kind: 'unchanged' }
  | { kind: 'diverged' }
  | { kind: 'shared' }
  | { kind: 'abandoned' }
  | { kind: 'refused'; error: string }
  | { kind: 'error'; error: string };

interface DisplacedSidecar {
  xmp: string;
  sha256: string;
  incomingSha256: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A publish that threw, as an outcome the caller can report. */
export function errorOutcome(error: unknown): { kind: 'error'; error: string } {
  return { kind: 'error', error: error instanceof Error ? error.message : String(error) };
}

/** `X-Maple-Sidecar-Base`: absent → `undefined` (legacy skip-if-exists),
 * `none` → `null`, a SHA-256 hex digest → itself, anything else → `'invalid'`. */
export function parseSidecarBase(
  header: string | undefined,
): string | null | undefined | 'invalid' {
  if (header === undefined) return undefined;
  if (header === 'none') return null;
  return SHA256_HEX.test(header) ? header : 'invalid';
}

/** The destination stopped passing the library-root check after the
 * up-front one, e.g. a parent folder was swapped for a symlink. */
class RefusedPath extends Error {}

/** Keeps a displaced sidecar; the returned function drops that record again
 * when the publish it was made for fails. */
type RecordDisplaced = (displaced: DisplacedSidecar) => Promise<() => Promise<void>>;

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

/** Publish over an existing sidecar: leave an identical one alone, overwrite
 * the named base, and keep anything else before landing the edit on top. */
async function publishOver(
  destination: string,
  publishPath: string,
  current: string,
  xmp: string,
  base: string | null,
  recordDisplaced: RecordDisplaced,
  shared: boolean,
  beforeWrite: () => Promise<void>,
): Promise<SidecarCasOutcome> {
  const incomingSha256 = sidecarSha256(xmp);
  const currentSha256 = sidecarSha256(current);
  if (currentSha256 === incomingSha256) return { kind: 'unchanged' };
  const diverged = currentSha256 !== base;
  if (diverged && shared) {
    await recordDisplaced({ xmp, sha256: incomingSha256, incomingSha256 });
    return { kind: 'shared' };
  }
  await beforeWrite();
  const forget = diverged
    ? await recordDisplaced({ xmp: current, sha256: currentSha256, incomingSha256 })
    : null;
  const written = await writeSidecarAtomic(publishPath, xmp, 'sidecar write failed');
  if (!written.ok) {
    // Drop the record only while the displaced version is still on disk, so a
    // retry doesn't pile up copies (#5023). A leftover row is harmless.
    const stillThere = (await readCurrent(destination).catch(() => null)) === current;
    if (stillThere) await forget?.().catch(() => undefined);
    return { kind: 'error', error: written.error };
  }
  return { kind: diverged ? 'diverged' : 'written' };
}

/** Create the sidecar when none exists; `null` when one appeared first. */
async function createIfAbsent(
  publishPath: string,
  xmp: string,
  beforeWrite: () => Promise<void>,
): Promise<SidecarCasOutcome | null> {
  await beforeWrite();
  const created = await writeSidecarCreateOnly(publishPath, xmp, 'sidecar write failed');
  if (created.ok) return { kind: 'written' };
  return 'exists' in created ? null : { kind: 'error', error: created.error };
}

/** Jail-authorize the destination (through symlinked parents) before its
 * directory is created, so nothing is ever made outside the library. */
async function prepareDestination(destination: string): Promise<SidecarCasOutcome | null> {
  const allowed = await authorizeSidecarWrite(destination);
  if (!allowed.ok) return { kind: 'refused', error: allowed.error ?? 'path not allowed' };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  return null;
}

async function publishAt(
  target: string,
  publishPath: string,
  xmp: string,
  base: string | null,
  recordDisplaced: RecordDisplaced,
  shared: boolean,
  beforeWrite: () => Promise<void>,
): Promise<SidecarCasOutcome> {
  // Once only: a create that lost the race goes on to publish over the newcomer.
  const ahead = once(beforeWrite);
  const existing = await readCurrent(target);
  const created = existing === null ? await createIfAbsent(publishPath, xmp, ahead) : null;
  if (created) return created;
  // A writer outside the barrier can create the file between the read and
  // the create-only publish; compare against what is actually there.
  const current = existing ?? (await readCurrent(target));
  if (current === null) return { kind: 'error', error: 'sidecar vanished during write' };
  return publishOver(target, publishPath, current, xmp, base, recordDisplaced, shared, ahead);
}

function once(run: () => Promise<void>): () => Promise<void> {
  const ran: { promise?: Promise<void> } = {};
  return () => (ran.promise ??= run());
}

/** Re-authorized after the barrier wait: the folder may now be an outward symlink. */
async function authorizedTarget(
  destination: string,
  resolved: string,
): Promise<string | SidecarCasOutcome> {
  const allowed = await authorizeSidecarWrite(destination);
  if (!allowed.ok) return { kind: 'refused', error: allowed.error ?? 'path not allowed' };
  const target = allowed.data ?? destination;
  // A path re-routed while queued wasn't the one these barrier keys cover.
  return path.resolve(target) === path.resolve(resolved)
    ? target
    : { kind: 'error', error: 'sidecar path changed while waiting; retry' };
}

export interface SidecarCasOptions {
  /** Whether a same-stem sibling shares the sidecar (#4692), asked inside the barrier. */
  shared?: () => Promise<boolean>;
  /** Checked inside the barrier before publishing; `false` abandons the write. */
  precondition?: () => Promise<boolean>;
  /** Runs inside the barrier just before the bytes are written; a throw writes nothing. */
  beforeWrite?: () => Promise<void>;
  /** Runs inside the barrier once the edit landed or was kept aside; a throw fails the publish. */
  afterLanded?: (outcome: SidecarCasOutcome) => Promise<void>;
}

const LANDED: ReadonlySet<SidecarCasOutcome['kind']> = new Set([
  'written',
  'unchanged',
  'diverged',
  'shared',
]);

export async function publishSidecarCas(
  destination: string,
  xmp: string,
  base: string | null,
  recordDisplaced: RecordDisplaced,
  admissionScope: string,
  options: SidecarCasOptions = {},
): Promise<SidecarCasOutcome> {
  const refused = await prepareDestination(destination);
  if (refused) return refused;
  return serializeSidecarWrite<SidecarCasOutcome>(
    destination,
    async (resolved) => {
      const target = await authorizedTarget(destination, resolved);
      if (typeof target !== 'string') return target;
      if (options.precondition && !(await options.precondition())) return { kind: 'abandoned' };
      const shared = (await options.shared?.()) ?? false;
      const outcome = await publishAt(
        target,
        destination,
        xmp,
        base,
        recordDisplaced,
        shared,
        options.beforeWrite ?? (async () => undefined),
      );
      if (LANDED.has(outcome.kind)) await options.afterLanded?.(outcome);
      return outcome;
    },
    {
      admissionScope,
      // Also reserves the resolved path's barrier keys so aliases queue together.
      resolveDestination: async () => {
        const recheck = await authorizeSidecarWrite(destination);
        if (!recheck.ok) throw new RefusedPath(recheck.error ?? 'path not allowed');
        return recheck.data ?? destination;
      },
    },
  ).catch((error: unknown) => {
    if (error instanceof RefusedPath) return { kind: 'refused', error: error.message };
    throw error;
  });
}

/** The legacy rule for clients that name no base (#698): publish only when no
 * sidecar exists. Create-only, and under the same barrier as compare-and-swap
 * writes, so it can never land over an edit published in the meantime. */
export async function publishSidecarIfAbsent(
  destination: string,
  xmp: string,
  admissionScope: string,
  hooks: { precondition: () => Promise<boolean>; beforeWrite: () => Promise<void> },
): Promise<'written' | 'skipped' | SidecarCasOutcome> {
  const refused = await prepareDestination(destination);
  if (refused) return refused;
  return serializeSidecarWrite(
    destination,
    async (resolved) => {
      if (!(await hooks.precondition())) return { kind: 'abandoned' };
      // Anything already at the name, readable or not, is an existing sidecar.
      if ((await readCurrent(resolved).catch(() => 'unreadable')) !== null) return 'skipped';
      await hooks.beforeWrite();
      const created = await writeSidecarCreateOnly(resolved, xmp, 'sidecar write failed');
      if (created.ok) return 'written';
      if ('exists' in created) return 'skipped';
      // A symlink swapped in after the up-front check is still a refusal.
      const recheck = await authorizeSidecarWrite(destination);
      return recheck.ok
        ? { kind: 'error', error: created.error }
        : { kind: 'refused', error: recheck.error ?? 'path not allowed' };
    },
    { admissionScope },
  );
}
