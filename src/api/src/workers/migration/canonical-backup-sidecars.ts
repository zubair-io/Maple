/**
 * Migration: "Canonical backup sidecars" (#5021).
 *
 * Until #5021 the backup sidecar route wrote a photo's edit to the full file
 * name plus `.xmp` (`IMG_1234.HEIC.xmp`), which the server never reads; the
 * canonical sidecar swaps the extension (`IMG_1234.xmp`). Videos already used
 * their canonical full-name sidecar, so only photos move.
 *
 * The migration runs in the worker child, outside the API process's in-memory
 * sidecar barrier, so it never overwrites a canonical sidecar:
 *   - none yet → the old-name edit is published there, create-only;
 *   - one exists (a server edit, or one shared with a same-stem photo) → it
 *     stays active and the old-name edit is kept in `sidecar_divergences`.
 * A live device's re-send still lands its edit on top through the API. The
 * old-name file is removed only once its edit is safe, and only if it still
 * holds the bytes that were read.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ObjectId } from '../../db/object-id.ts';
import type { FileInfo } from '../../db/schema.ts';
import {
  countCandidates,
  HAS_LIVE_LOCATION,
  type CandidateScope,
  type MigrationCandidate,
} from '../../db/repos/assets.migrations.ts';
import {
  hasSidecarDivergence,
  recordSidecarDivergence,
} from '../../db/repos/sidecar-divergences.repo.ts';
import { serializeSidecarWrite } from '../../fs/sidecar-write-order.ts';
import {
  markCanonicalSidecarsChecked,
  NEEDS_CANONICAL_SIDECAR_CHECK,
} from '../../db/repos/backup-sidecar-name-checks.repo.ts';
import { errorOutcome, publishSidecarIfAbsent } from '../../backup/sidecar-cas.ts';
import { isLiveLocationOfAsset } from '../../db/repos/backup.repo.ts';
import {
  legacyBackupSidecar,
  readLegacyBackupEdit,
  removeLegacyIfUnchanged,
} from '../../backup/legacy-sidecar.ts';
import { readSidecarBytes } from '../../fs/sidecar-ownership.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { announceSidecarLanded, recordSidecarEditAhead } from '../../routes/xmp-change.ts';
import { libraryRootAvailable } from '../missing-reaper.helpers.ts';
import { isLiveFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { child as childLogger } from '../../log.ts';
import { runCandidateBatch, type CandidateOutcome, type LibraryRoots } from './candidate-batch.ts';
import { MigrationBlockedError, type Migration, type MigrationBatchResult } from './types.ts';

const log = childLogger('migration:canonical-backup-sidecars');

const MIGRATION_ID = 'canonical-backup-sidecars';
/** Recorded as the divergence's device: the migration, not a phone, kept it. */
const DIVERGENCE_SOURCE = `migration:${MIGRATION_ID}`;

const CANDIDATES: CandidateScope = {
  sql: `${HAS_LIVE_LOCATION} AND ${NEEDS_CANONICAL_SIDECAR_CHECK}`,
};

type LocationOutcome = 'done' | 'kept' | 'error';

interface LegacyEdit {
  assetId: ObjectId;
  location: FileInfo;
  primary: string;
  root: string;
  legacy: string;
  bytes: Buffer;
}

const canonicalRelPath = (edit: LegacyEdit): string =>
  path.posix.join(edit.location.path, path.basename(xmpSidecarPath(edit.primary)));

/** The scan's reading still holds: the photo is at this location and its old-name file is unchanged. */
async function stillCurrent(edit: LegacyEdit): Promise<boolean> {
  const { assetId, location, primary, bytes } = edit;
  return (
    (await isLiveLocationOfAsset(
      assetId,
      location.library_id,
      path.posix.join(location.path, location.filename),
    )) && (await readLegacyBackupEdit(primary).catch(() => null))?.equals(bytes) === true
  );
}

/** Re-checked first, so a photo moved since leaves its old-name file in place. */
async function keepAsideAndRemove(edit: LegacyEdit): Promise<void> {
  await serializeSidecarWrite(xmpSidecarPath(edit.primary), async () => {
    if (!(await stillCurrent(edit))) return;
    const current = await readSidecarBytes(xmpSidecarPath(edit.primary));
    const xmp = edit.bytes.toString('utf8');
    const digest = createHash('sha256').update(xmp, 'utf8').digest('hex');
    const kept = {
      assetId: edit.assetId,
      libraryId: edit.location.library_id,
      sidecarRelPath: canonicalRelPath(edit),
      displacedSha256: digest,
      incomingSha256: digest,
    };
    const already = await hasSidecarDivergence({ ...kept, incomingSha256: undefined });
    if (!current?.equals(edit.bytes) && !already) {
      await recordSidecarDivergence({
        ...kept,
        deviceId: DIVERGENCE_SOURCE,
        baseSha256: null,
        displacedXmp: xmp,
      });
    }
    await removeLegacyIfUnchanged(edit.primary, edit.legacy, edit.bytes);
  });
}

/** Create-only: the migration runs in the worker child, outside the API process's
 * in-memory barrier, so it never overwrites a canonical sidecar. A live device's
 * re-send still lands its edit on top through the API (#5021). */
async function publishCanonical(edit: LegacyEdit): Promise<LocationOutcome> {
  const { assetId, primary, root } = edit;
  const sidecarRelPath = canonicalRelPath(edit);
  const outcome = await publishSidecarIfAbsent(
    xmpSidecarPath(primary),
    edit.bytes.toString('utf8'),
    root,
    { precondition: () => stillCurrent(edit), beforeWrite: () => recordSidecarEditAhead(primary) },
  ).catch(errorOutcome);
  if (outcome === 'written') await announceSidecarLanded(primary);
  if (outcome === 'written' || outcome === 'skipped') {
    await keepAsideAndRemove(edit);
    return 'done';
  }
  if (outcome.kind === 'refused') {
    // Retrying cannot make an out-of-library path safe; leave the file and move on.
    log.warn(
      { _id: String(assetId), sidecarRelPath, error: outcome.error },
      'sidecar path refused',
    );
    return 'kept';
  }
  if (outcome.kind === 'abandoned') return 'done';
  log.warn(
    {
      _id: String(assetId),
      sidecarRelPath,
      error: 'error' in outcome ? outcome.error : outcome.kind,
    },
    'canonical sidecar not published — old-name sidecar left for retry',
  );
  return 'error';
}

function supersededByASend(
  assetId: ObjectId,
  location: FileInfo,
  primary: string,
  legacyBytes: Buffer,
): Promise<boolean> {
  return hasSidecarDivergence({
    assetId,
    libraryId: location.library_id,
    sidecarRelPath: path.posix.join(location.path, path.basename(xmpSidecarPath(primary))),
    displacedSha256: createHash('sha256')
      .update(legacyBytes.toString('utf8'), 'utf8')
      .digest('hex'),
  });
}

async function canonicalizeLocation(
  assetId: ObjectId,
  location: FileInfo,
  root: string,
): Promise<LocationOutcome> {
  const primary = path.join(root, location.path, location.filename);
  const legacy = legacyBackupSidecar(primary);
  try {
    const legacyBytes = legacy ? await readLegacyBackupEdit(primary) : null;
    if (!legacy || !legacyBytes) return 'done';
    if (await supersededByASend(assetId, location, primary, legacyBytes)) {
      // A device send landed and kept this edit aside, but couldn't remove the file.
      await serializeSidecarWrite(xmpSidecarPath(primary), () =>
        removeLegacyIfUnchanged(primary, legacy, legacyBytes),
      );
      return 'done';
    }
    return await publishCanonical({ assetId, location, primary, root, legacy, bytes: legacyBytes });
  } catch (err) {
    log.error(
      { _id: String(assetId), legacy, err: err instanceof Error ? err.message : err },
      'canonical sidecar migration failed — left for retry',
    );
    return 'error';
  }
}

interface RootedLocation {
  location: FileInfo;
  root: string;
}

/** One location at a time: the locations of one photo can share a sidecar barrier. */
async function canonicalizeAll(
  assetId: ObjectId,
  rooted: readonly RootedLocation[],
): Promise<LocationOutcome> {
  for (const { location, root } of rooted) {
    if ((await canonicalizeLocation(assetId, location, root)) === 'error') return 'error';
  }
  return 'done';
}

async function allMounted(rooted: readonly RootedLocation[]): Promise<boolean> {
  const mounted = await Promise.all(rooted.map(({ root }) => libraryRootAvailable(root)));
  return !mounted.includes(false);
}

async function canonicalizeAsset(
  libs: LibraryRoots,
  doc: MigrationCandidate,
): Promise<CandidateOutcome> {
  const photos = doc.fileinfo.filter(
    (location) => isLiveFileInfo(location) && !isVideoFilename(location.filename),
  );
  const rooted = photos
    .map((location) => ({ location, root: libs.get(location.library_id.toHexString()) }))
    .filter((entry): entry is RootedLocation => entry.root !== undefined);
  if (rooted.length !== photos.length) return 'skipped-no-root';
  // An unmounted volume reads like a missing file, so it is checked on both sides of the scan.
  if (!(await allMounted(rooted))) return 'skipped-no-root';
  if ((await canonicalizeAll(doc.id, rooted)) === 'error') return 'error';
  if (!(await allMounted(rooted))) return 'skipped-no-root';
  const live = doc.fileinfo.filter(isLiveFileInfo);
  return (await markCanonicalSidecarsChecked(doc.id, live)) ? 'processed' : 'retry-later';
}

/** One batch of the migration's work, independent of the #5063 gate below. */
export function runCanonicalBackupSidecarsBatch(batchSize: number): Promise<MigrationBatchResult> {
  return runCandidateBatch({
    scope: CANDIDATES,
    batchSize,
    log,
    skippedWarning: 'canonical backup sidecars: assets skipped — library root not resolved',
    process: canonicalizeAsset,
  });
}

export const canonicalBackupSidecars: Migration = {
  id: MIGRATION_ID,
  title: 'Canonical backup sidecars',
  description:
    'Moves backed-up photo edits saved as IMG_1234.HEIC.xmp to the IMG_1234.xmp the server ' +
    'reads (#5021). Where an IMG_1234.xmp already exists it stays the active edit and the ' +
    'backup edit is kept as a divergence; nothing is overwritten or deleted without being ' +
    'recorded. Videos are unchanged. Blocked until #5063 lands. One-time; idempotent.',

  countRemaining(): Promise<number> {
    return countCandidates(CANDIDATES);
  },

  // Staged behind #5063: until movers carry old-name sidecars, a moved photo's edit would strand.
  async runBatch(): Promise<MigrationBatchResult> {
    throw new MigrationBlockedError(
      'Blocked until #5063 lands: movers must carry old-name IMG.HEIC.xmp sidecars first.',
    );
  },
};
