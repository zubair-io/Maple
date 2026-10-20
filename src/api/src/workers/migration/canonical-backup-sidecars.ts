/**
 * Migration: "Canonical backup sidecars" (#5021).
 *
 * Until #5021 the backup sidecar route wrote a photo's edit to the full file
 * name plus `.xmp` (`IMG_1234.HEIC.xmp`), which the server never reads; the
 * canonical sidecar swaps the extension (`IMG_1234.xmp`). Videos already used
 * their canonical full-name sidecar, so only photos move.
 *
 * Per backed-up photo location, the old file is published to the canonical
 * name through the same compare-and-swap the route uses, based on no version:
 *   - no canonical sidecar yet → it is moved there;
 *   - the canonical sidecar holds the same edit → the old copy is dropped;
 *   - it holds a different (server) edit → the backup edit lands on top and the
 *     server version is kept in `sidecar_divergences`;
 *   - a same-stem sibling shares it (#4692) → it is kept, and the backup edit
 *     is recorded in `sidecar_divergences` instead.
 * The old file is removed only once its edit is safe, and only if it still
 * holds the bytes that were published.
 */
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
  forgetSidecarDivergence,
  recordSidecarDivergence,
} from '../../db/repos/sidecar-divergences.repo.ts';
import {
  markCanonicalSidecarsChecked,
  NEEDS_CANONICAL_SIDECAR_CHECK,
} from '../../db/repos/backup-sidecar-name-checks.repo.ts';
import { publishSidecarCas } from '../../backup/sidecar-cas.ts';
import {
  legacyBackupSidecar,
  readLegacyBackupEdit,
  removeLegacyIfUnchanged,
} from '../../backup/legacy-sidecar.ts';
import { sidecarStemClaimedBySibling } from '../../fs/sidecar-ownership.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import { publishSidecarChange } from '../../routes/xmp-change.ts';
import { libraryRootAvailable } from '../missing-reaper.helpers.ts';
import { isLiveFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { child as childLogger } from '../../log.ts';
import { runCandidateBatch, type CandidateOutcome, type LibraryRoots } from './candidate-batch.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:canonical-backup-sidecars');

const MIGRATION_ID = 'canonical-backup-sidecars';
/** Recorded as the divergence's device: the migration, not a phone, kept it. */
const DIVERGENCE_SOURCE = `migration:${MIGRATION_ID}`;

const CANDIDATES: CandidateScope = {
  sql: `${HAS_LIVE_LOCATION} AND ${NEEDS_CANONICAL_SIDECAR_CHECK}`,
};

type LocationOutcome = 'done' | 'kept' | 'error';

async function publishCanonical(
  assetId: ObjectId,
  location: FileInfo,
  primary: string,
  root: string,
  legacy: string,
  legacyBytes: Buffer,
): Promise<LocationOutcome> {
  const canonical = xmpSidecarPath(primary);
  const sidecarRelPath = path.posix.join(location.path, path.basename(canonical));
  const outcome = await publishSidecarCas(
    canonical,
    legacyBytes.toString('utf8'),
    null,
    async (displaced) => {
      const id = await recordSidecarDivergence({
        assetId,
        libraryId: location.library_id,
        sidecarRelPath,
        deviceId: DIVERGENCE_SOURCE,
        baseSha256: null,
        displacedSha256: displaced.sha256,
        displacedXmp: displaced.xmp,
        incomingSha256: displaced.incomingSha256,
      });
      return () => forgetSidecarDivergence(id);
    },
    root,
    {
      shared: () => sidecarStemClaimedBySibling(primary),
      // A device send may have retired the file since it was read.
      precondition: async () =>
        (await readLegacyBackupEdit(legacy).catch(() => null))?.equals(legacyBytes) === true,
      afterLanded: () => removeLegacyIfUnchanged(legacy, legacyBytes),
    },
  );
  if (outcome.kind === 'refused') {
    // Retrying cannot make an out-of-library path safe; leave the file and move on.
    log.warn(
      { _id: String(assetId), sidecarRelPath, error: outcome.error },
      'sidecar path refused',
    );
    return 'kept';
  }
  if (outcome.kind === 'error') {
    log.warn(
      { _id: String(assetId), sidecarRelPath, error: outcome.error },
      'canonical sidecar not published — old-name sidecar left for retry',
    );
    return 'error';
  }
  if (outcome.kind === 'written' || outcome.kind === 'diverged') {
    await publishSidecarChange(primary, true);
  }
  return 'done';
}

async function canonicalizeLocation(
  assetId: ObjectId,
  location: FileInfo,
  root: string,
): Promise<LocationOutcome> {
  const primary = path.join(root, location.path, location.filename);
  const legacy = legacyBackupSidecar(primary);
  try {
    const legacyBytes = legacy ? await readLegacyBackupEdit(legacy) : null;
    if (!legacy || !legacyBytes) return 'done';
    return await publishCanonical(assetId, location, primary, root, legacy, legacyBytes);
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
  // An unmounted volume reads like a missing file; never stamp on that reading.
  const mounted = await Promise.all(rooted.map(({ root }) => libraryRootAvailable(root)));
  if (mounted.includes(false)) return 'skipped-no-root';
  if ((await canonicalizeAll(doc.id, rooted)) === 'error') return 'error';
  await markCanonicalSidecarsChecked(doc.id);
  return 'processed';
}

export const canonicalBackupSidecars: Migration = {
  id: MIGRATION_ID,
  title: 'Canonical backup sidecars',
  description:
    'Moves backed-up photo edits saved as IMG_1234.HEIC.xmp to the IMG_1234.xmp the server ' +
    'reads (#5021). Where a server edit already exists, the backup edit is placed on top and ' +
    'the server version is kept as a divergence; a sidecar shared with a same-stem photo is ' +
    'kept and the backup edit recorded instead. Videos are unchanged. One-time; idempotent.',

  countRemaining(): Promise<number> {
    return countCandidates(CANDIDATES);
  },

  runBatch(batchSize: number): Promise<MigrationBatchResult> {
    return runCandidateBatch({
      scope: CANDIDATES,
      batchSize,
      log,
      skippedWarning: 'canonical backup sidecars: assets skipped — library root not resolved',
      process: canonicalizeAsset,
    });
  },
};
