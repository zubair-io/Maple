// library-cache.byte-source.ts — the per-backend byte-read branch dispatch
// for `LibraryCache._doReadBytes`, split out so `library-cache.service.ts`
// stays under the file-size budget (CONTRIBUTING.md § "File-size budget").
//
// Branch order: legacy in-memory → M2 (`slug:relPath`) network read →
// Self-Hosted apiId → Hosted FS-Access handle. The M2 branch is the one
// wrapped in `withTransientRetry` (#2407) — it's the network GET every
// browse-opened Self-Hosted asset takes, and the one that used to surface a
// transient blip as a permanent blank canvas. The legacy FS-walk absPath
// branch (`/api/fs/raw`) was retired in #1325: nothing has populated
// `assetAbsPaths` since the M2 cutover, so a legacy `fs:` id with no api id
// rejects here rather than reaching the path-addressed route.

import { firstValueFrom } from 'rxjs';
import type { AssetId } from '../models/asset';
import type { ServerLibraryIo } from '../workspace/server-library-io';
import type { DownloadProgress } from '../api/filesystem-browse.service';
import type { LibraryBackendKind } from '../api/library-backend.token';
import type { FolderEntry } from '../folder-access/folder-access.types';
import type { LibrarySource } from '../addressing/library-source';
import { parseAddress } from '../addressing/maple-address';
import { withTransientRetry } from './library-cache.byte-retry';

/** True for an M2 (`slug:relPath`) MapleAddress id — never a legacy `fs:` deep link. */
export function isM2Asset(id: AssetId): boolean {
  return typeof id === 'string' && id.includes(':') && !id.startsWith('fs:');
}

export interface ByteSourceDeps {
  legacyBytes: Map<AssetId, Uint8Array>;
  librarySource: LibrarySource;
  backend: LibraryBackendKind;
  apiAssetIds: Map<AssetId, string>;
  api: ServerLibraryIo | null;
  fileHandles: Map<AssetId, FolderEntry>;
  makeProgressCallback: (id: AssetId) => (p: DownloadProgress) => void;
}

async function readM2Bytes(id: AssetId, deps: ByteSourceDeps): Promise<Uint8Array> {
  const onProgress = deps.makeProgressCallback(id);
  const blob = await withTransientRetry(() =>
    deps.librarySource.imageBlob(parseAddress(id), onProgress),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

async function readSelfHostedBytes(id: AssetId, deps: ByteSourceDeps): Promise<Uint8Array> {
  const apiId = deps.apiAssetIds.get(id);
  if (!apiId) throw new Error(`bytesForAsset: no api id for asset ${id}`);
  if (!deps.api) throw new Error('bytesForAsset: Self Hosted library I/O is not configured');
  const buf = await firstValueFrom(deps.api.getRawBytes(apiId, deps.makeProgressCallback(id)));
  return new Uint8Array(buf);
}

async function readFsAccessBytes(id: AssetId, deps: ByteSourceDeps): Promise<Uint8Array> {
  const entry = deps.fileHandles.get(id);
  if (!entry) throw new Error(`bytesForAsset: no handle for asset ${id}`);
  const file = await entry.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Dispatch a lazy byte read for `id` across every `LibraryCache` backend. */
export async function readAssetBytes(id: AssetId, deps: ByteSourceDeps): Promise<Uint8Array> {
  const legacy = deps.legacyBytes.get(id);
  if (legacy) return legacy;

  if (isM2Asset(id)) {
    return readM2Bytes(id, deps);
  }

  if (deps.backend === 'self-hosted') {
    return readSelfHostedBytes(id, deps);
  }

  return readFsAccessBytes(id, deps);
}
