import { listLibraryRoots } from '../db/repos/folders.repo';
import type { SqliteDb } from '../db/repos/db-handle';
import { stat } from '../fs/mirrored';
import { SidecarWritePathDeniedError, type SidecarWriteScope } from '../fs/sidecar-write-order';
/** Actual primary publication updates library sidecar state and the change feed (#3563 / #4051). */
import { ObjectId } from '../db/object-id';
import { mostSpecificRoot } from '../fs/root-match';
import { loadLibraryRoots } from '../indexer/libraries.cache';
import { findDetailByAddress, recordSidecarEdit, setHasXmp } from '../db/assets.repo';
import {
  recordAndPublishAssetChange,
  recordAndPublishAssetChangeOrThrow,
} from '../db/changes.repo';
import { child as childLogger } from '../log';
const log = childLogger('xmp-routes');

/** Only registered libraries resolve; env and test roots carry synthetic keys. */
async function assetAt(
  rawAbsPath: string,
  dbOverride?: SqliteDb,
): Promise<{ id: ObjectId; libraryId: ObjectId } | null> {
  const roots = dbOverride
    ? new Map(
        (await listLibraryRoots(dbOverride)).map((root) => [root.id.toHexString(), root.path]),
      )
    : await loadLibraryRoots();
  const hit = mostSpecificRoot(rawAbsPath, roots);
  if (!hit || hit.relPath === '' || !ObjectId.isValid(hit.key)) return null;
  const libraryId = new ObjectId(hit.key);
  const dto = await findDetailByAddress(libraryId, hit.relPath, dbOverride);
  return dto ? { id: new ObjectId(dto.id), libraryId } : null;
}

async function primaryIdentity(rawPath: string): Promise<string | null> {
  return stat(rawPath, { bigint: true }).then(
    (value) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    },
  );
}

/** Recheck after the save barrier: a purge/move must not leave an orphan edit,
 * and Replace must not give a new primary the displaced photo's queued save. */
export async function captureSidecarWriteScope(
  rawPath: string,
  directory: string,
  dbOverride?: SqliteDb,
): Promise<SidecarWriteScope> {
  const [asset, identity] = await Promise.all([
    assetAt(rawPath, dbOverride),
    primaryIdentity(rawPath),
  ]);
  return {
    directory,
    async validate() {
      const [current, currentIdentity] = await Promise.all([
        assetAt(rawPath, dbOverride),
        primaryIdentity(rawPath),
      ]);
      if (asset?.id.toHexString() !== current?.id.toHexString() || identity !== currentIdentity) {
        throw new SidecarWritePathDeniedError(
          'Photo moved, was replaced or was purged; reload before saving edits',
        );
      }
    },
  };
}

function announce(
  asset: { id: ObjectId; libraryId: ObjectId },
  rawAbsPath: string,
  record = recordAndPublishAssetChange,
) {
  return record({
    kind: 'update',
    asset_id: asset.id,
    folder_id: asset.libraryId,
    abs_path: rawAbsPath,
  });
}

/** Strict: record an edit about to land (has_xmp, sidecar_ver, change feed); throws on failure. */
export async function recordSidecarEditAhead(rawAbsPath: string): Promise<void> {
  const asset = await assetAt(rawAbsPath);
  if (!asset) return;
  await recordSidecarEdit(asset.id);
  await announce(asset, rawAbsPath, recordAndPublishAssetChangeOrThrow);
}

/** Best effort, once the bytes are on disk: bump and announce again, so a cloud-backup
 * capture or refetch that ran ahead of the write is redone. */
export async function announceSidecarLanded(rawAbsPath: string): Promise<void> {
  const asset = await assetAt(rawAbsPath).catch(() => null);
  if (!asset) return;
  await recordSidecarEdit(asset.id).catch(() => undefined);
  await announce(asset, rawAbsPath).catch(() => undefined);
}

export async function publishSidecarChange(rawAbsPath: string, edited: boolean): Promise<void> {
  try {
    const asset = await assetAt(rawAbsPath);
    if (!asset) return;
    if (edited) {
      await recordSidecarEdit(asset.id);
    } else {
      await setHasXmp(asset.id, false);
    }
    await announce(asset, rawAbsPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, path: rawAbsPath },
      `publishSidecarChange failed (best-effort, ignoring): ${detail}`,
    );
  }
}
