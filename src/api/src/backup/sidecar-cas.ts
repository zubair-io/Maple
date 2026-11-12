/**
 * Compare-and-swap publish for a backup sidecar re-send (#4719, #5796).
 *
 * The device names the version its edit was based on: the head entry id of the
 * sidecar's edit history, or the SHA-256 of the XMP it last delivered (`none` for
 * neither). Under the shared sidecar write barrier:
 *   - nothing on disk yet → create it, with the send as the first history entry;
 *   - the server already holds exactly this edit → leave it alone;
 *   - the server still holds the base version → the send replaces the adjustments;
 *   - anything else is reconciled onto the stored sidecar (`sidecar-history.ts`):
 *     the send lands on top, what it displaced stays in the history, and no
 *     separate record is kept;
 *   - except when a same-stem sibling shares the sidecar (#4692): then only the
 *     named base may be replaced, and any other incoming edit is kept aside
 *     (`keepAside`) instead, so one photo never overwrites the other's edits.
 */
import {
  authorizeSidecarWrite,
  isMissingSidecar,
  readSidecarNoFollow,
  writeSidecarAtomic,
  writeSidecarCreateOnly,
} from '../fs/sidecar-io.ts';
import { serializeSidecarWrite } from '../fs/sidecar-write-order.ts';
// Mirror-aware drop-in, so the sidecar's directory replicates with it.
import fs, { replicatePathUnder } from '../fs/mirrored.ts';
import path from 'node:path';
import {
  firstBackupSidecar,
  reconcileBackupSidecar,
  sha256Hex,
  type SidecarBase,
} from './sidecar-history.ts';

type SidecarCasOutcome =
  | { kind: 'written'; head: string }
  | { kind: 'reconciled'; head: string }
  | { kind: 'unchanged'; head: string | null }
  | { kind: 'shared' }
  | { kind: 'abandoned' }
  | { kind: 'refused'; error: string }
  | { kind: 'error'; error: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A publish that threw, as an outcome the caller can report. */
export function errorOutcome(error: unknown): { kind: 'error'; error: string } {
  return { kind: 'error', error: error instanceof Error ? error.message : String(error) };
}

/** `X-Maple-Sidecar-Head` (a history entry id or `none`) names the base by history and
 * wins over `X-Maple-Sidecar-Base` (a SHA-256 hex digest or `none`). Neither present →
 * `undefined` (legacy skip-if-exists); anything malformed → `'invalid'`. */
export function parseSidecarBase(
  head: string | undefined,
  digest: string | undefined,
): SidecarBase | undefined | 'invalid' {
  if (head !== undefined) {
    if (head === 'none') return { kind: 'head', head: null };
    return ENTRY_ID.test(head) ? { kind: 'head', head } : 'invalid';
  }
  if (digest === undefined) return undefined;
  if (digest === 'none') return { kind: 'digest', sha256: null };
  return SHA256_HEX.test(digest) ? { kind: 'digest', sha256: digest } : 'invalid';
}

/** The destination stopped passing the library-root check after the
 * up-front one, e.g. a parent folder was swapped for a symlink. */
class RefusedPath extends Error {}

/** Keeps an edit a shared sidecar refused to take. */
type KeepAside = (incoming: { xmp: string; sha256: string }) => Promise<void>;

async function readCurrent(destination: string): Promise<string | null> {
  try {
    return await readSidecarNoFollow(destination);
  } catch (error) {
    if (isMissingSidecar(error)) return null;
    throw error;
  }
}

interface Publication {
  xmp: string;
  base: SidecarBase;
  keepAside: KeepAside;
  shared: boolean;
}

/** Publish over an existing sidecar: place the send on its history, or keep it aside. */
async function publishOver(
  destination: string,
  current: string,
  send: Publication,
  beforeWrite: () => Promise<void>,
): Promise<SidecarCasOutcome> {
  const applied = await reconcileBackupSidecar({
    current,
    incoming: send.xmp,
    base: send.base,
    shared: send.shared,
    now: Date.now(),
  });
  if (applied.kind === 'unchanged') return applied;
  if (applied.kind === 'shared') {
    await send.keepAside({ xmp: send.xmp, sha256: sha256Hex(send.xmp) });
    return applied;
  }
  await beforeWrite();
  const written = await writeSidecarAtomic(destination, applied.xmp, 'sidecar write failed');
  if (!written.ok) return { kind: 'error', error: written.error };
  return { kind: applied.reconciled ? 'reconciled' : 'written', head: applied.head };
}

/** Create the sidecar when none exists; `null` when one appeared first. */
async function createIfAbsent(
  destination: string,
  xmp: string,
  beforeWrite: () => Promise<void>,
): Promise<SidecarCasOutcome | null> {
  const first = await firstBackupSidecar(xmp, Date.now());
  await beforeWrite();
  const created = await writeSidecarCreateOnly(destination, first.xmp, 'sidecar write failed');
  if (created.ok) return { kind: 'written', head: first.head };
  return 'exists' in created ? null : { kind: 'error', error: created.error };
}

/** Jail-authorize the destination (through symlinked parents) before its
 * directory is created, so nothing is ever made outside the library. */
async function prepareDestination(destination: string): Promise<SidecarCasOutcome | null> {
  const allowed = await authorizeSidecarWrite(destination);
  if (!allowed.ok) return { kind: 'refused', error: allowed.error ?? 'path not allowed' };
  await fs.mkdir(path.dirname(allowed.data ?? destination), { recursive: true });
  return null;
}

async function publishAt(
  target: string,
  send: Publication,
  beforeWrite: () => Promise<void>,
): Promise<SidecarCasOutcome> {
  // Once only: a create that lost the race goes on to publish over the newcomer.
  const ahead = once(beforeWrite);
  const existing = await readCurrent(target);
  const created = existing === null ? await createIfAbsent(target, send.xmp, ahead) : null;
  if (created) return created;
  // A writer outside the barrier can create the file between the read and
  // the create-only publish; compare against what is actually there.
  const current = existing ?? (await readCurrent(target));
  if (current === null) return { kind: 'error', error: 'sidecar vanished during write' };
  return publishOver(target, current, send, ahead);
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
  'reconciled',
  'shared',
]);

export async function publishSidecarCas(
  destination: string,
  xmp: string,
  base: SidecarBase,
  keepAside: KeepAside,
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
        { xmp, base, keepAside, shared },
        options.beforeWrite ?? (async () => undefined),
      );
      const landed = outcome.kind === 'written' || outcome.kind === 'reconciled';
      // The write is pinned to the resolved target; mirrors are keyed by the configured root.
      // An unaliased path was already replicated by the mirrored write itself.
      if (landed && path.resolve(target) !== path.resolve(destination)) {
        replicatePathUnder(target, destination);
      }
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
