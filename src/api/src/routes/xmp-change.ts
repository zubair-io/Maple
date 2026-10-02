/** Actual primary publication updates library sidecar state and the change feed (#3563 / #4051). */
import { ObjectId } from '../db/object-id';
import { mostSpecificRoot } from '../fs/root-match';
import { loadLibraryRoots } from '../indexer/libraries.cache';
import { findDetailByAddress, recordSidecarEdit, setHasXmp } from '../db/assets.repo';
import { recordAndPublishAssetChange } from '../db/changes.repo';
import { child as childLogger } from '../log';
const log = childLogger('xmp-routes');

export async function publishSidecarChange(rawAbsPath: string, edited: boolean): Promise<void> {
  try {
    const hit = mostSpecificRoot(rawAbsPath, await loadLibraryRoots());
    // `MAPLE_ROOTS` env roots (and test-registered roots) carry synthetic
    // keys, not Mongo ids; only registered libraries have indexed assets.
    if (!hit || hit.relPath === '' || !ObjectId.isValid(hit.key)) return;
    const libraryId = new ObjectId(hit.key);
    const dto = await findDetailByAddress(libraryId, hit.relPath);
    if (!dto) return;
    const id = new ObjectId(dto.id);
    if (edited) {
      await recordSidecarEdit(id);
    } else {
      await setHasXmp(id, false);
    }
    await recordAndPublishAssetChange({
      kind: 'update',
      asset_id: id,
      folder_id: libraryId,
      abs_path: rawAbsPath,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(
      { err, path: rawAbsPath },
      `publishSidecarChange failed (best-effort, ignoring): ${detail}`,
    );
  }
}
