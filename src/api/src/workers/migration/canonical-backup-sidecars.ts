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
  BACKUP_ORIGIN,
  countCandidates,
  HAS_LIVE_LOCATION,
  stampMarker,
  unstamped,
  type CandidateScope,
  type MigrationCandidate,
} from '../../db/repos/assets.migrations.ts';
import {
  forgetSidecarDivergence,
  recordSidecarDivergence,
} from '../../db/repos/sidecar-divergences.repo.ts';
import { publishSidecarCas } from '../../backup/sidecar-cas.ts';
import { readSidecarBytes, sidecarStemClaimedBySibling } from '../../fs/sidecar-ownership.ts';
import { serializeSidecarWrite } from '../../fs/sidecar-write-order.ts';
import { xmpSidecarPath } from '../../fs/xmp.ts';
import * as fs from '../../fs/mirrored.ts';
import { isLiveFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { child as childLogger } from '../../log.ts';
import { runCandidateBatch, type CandidateOutcome, type LibraryRoots } from './candidate-batch.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:canonical-backup-sidecars');

const MIGRATION_ID = 'canonical-backup-sidecars';
const MARKER = 'backup_sidecar_name_version';
export const BACKUP_SIDECAR_NAME_VERSION = 1;
/** Recorded as the divergence's device: the migration, not a phone, kept it. */
const DIVERGENCE_SOURCE = `migration:${MIGRATION_ID}`;

const BACKED_UP_WITH_LIVE_LOCATION: CandidateScope = {
  sql: `${BACKUP_ORIGIN} AND ${HAS_LIVE_LOCATION}`,
};

function candidateScope(): CandidateScope {
  return unstamped(BACKED_UP_WITH_LIVE_LOCATION, MARKER, BACKUP_SIDECAR_NAME_VERSION);
}

type LocationOutcome = 'done' | 'error';

/** Publish the old-name sidecar's edit at `primary`'s canonical name. */
async function publishCanonical(
  assetId: ObjectId,
  location: FileInfo,
  primary: string,
  root: string,
  legacyXmp: string,
): Promise<LocationOutcome> {
  const canonical = xmpSidecarPath(primary);
  const sidecarRelPath = path.posix.join(location.path, path.basename(canonical));
  const outcome = await publishSidecarCas(
    canonical,
    legacyXmp,
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
    await sidecarStemClaimedBySibling(primary),
  );
  if (outcome.kind === 'refused' || outcome.kind === 'error') {
    log.warn(
      { _id: String(assetId), sidecarRelPath, outcome: outcome.kind, error: outcome.error },
      'canonical sidecar not published — old-name sidecar left for retry',
    );
    return 'error';
  }
  return 'done';
}

/** Drop the old-name file, unless a write changed it after it was published. */
async function removeLegacy(legacy: string, published: Buffer): Promise<void> {
  await serializeSidecarWrite(legacy, async () => {
    const current = await readSidecarBytes(legacy);
    if (current?.equals(published)) await fs.unlink(legacy);
  });
}

async function canonicalizeLocation(
  assetId: ObjectId,
  location: FileInfo,
  root: string,
): Promise<LocationOutcome> {
  const primary = path.join(root, location.path, location.filename);
  const legacy = `${primary}.xmp`;
  try {
    const legacyBytes = await readSidecarBytes(legacy);
    if (legacyBytes === null) return 'done';
    const published = await publishCanonical(
      assetId,
      location,
      primary,
      root,
      legacyBytes.toString('utf8'),
    );
    if (published === 'done') await removeLegacy(legacy, legacyBytes);
    return published;
  } catch (err) {
    log.error(
      { _id: String(assetId), legacy, err: err instanceof Error ? err.message : err },
      'canonical sidecar migration failed — left for retry',
    );
    return 'error';
  }
}

async function canonicalizeAsset(
  libs: LibraryRoots,
  doc: MigrationCandidate,
): Promise<CandidateOutcome> {
  const photos = doc.fileinfo.filter(
    (location) => isLiveFileInfo(location) && !isVideoFilename(location.filename),
  );
  const rooted = photos.map((location) => ({
    location,
    root: libs.get(location.library_id.toHexString()),
  }));
  if (rooted.some(({ root }) => root === undefined)) return 'skipped-no-root';
  const outcomes: LocationOutcome[] = [];
  for (const { location, root } of rooted) {
    outcomes.push(await canonicalizeLocation(doc.id, location, root!));
  }
  if (outcomes.includes('error')) return 'error';
  await stampMarker(MARKER, BACKUP_SIDECAR_NAME_VERSION, [doc.id]);
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
    return countCandidates(candidateScope());
  },

  runBatch(batchSize: number): Promise<MigrationBatchResult> {
    return runCandidateBatch({
      scope: candidateScope(),
      batchSize,
      log,
      skippedWarning: 'canonical backup sidecars: assets skipped — library root not resolved',
      process: canonicalizeAsset,
    });
  },
};
