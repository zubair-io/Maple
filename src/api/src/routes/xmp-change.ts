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

/** The indexed asset at `rawAbsPath`; `MAPLE_ROOTS` env and test roots carry
 * synthetic keys, so only registered libraries resolve. */
async function assetAt(rawAbsPath: string): Promise<{ id: ObjectId; libraryId: ObjectId } | null> {
  const hit = mostSpecificRoot(rawAbsPath, await loadLibraryRoots());
  if (!hit || hit.relPath === '' || !ObjectId.isValid(hit.key)) return null;
  const libraryId = new ObjectId(hit.key);
  const dto = await findDetailByAddress(libraryId, hit.relPath);
  return dto ? { id: new ObjectId(dto.id), libraryId } : null;
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

/** Best effort: announce again once the bytes are on disk, so an early refetch is corrected. */
export async function announceSidecarLanded(rawAbsPath: string): Promise<void> {
  const asset = await assetAt(rawAbsPath).catch(() => null);
  if (asset) await announce(asset, rawAbsPath).catch(() => undefined);
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
