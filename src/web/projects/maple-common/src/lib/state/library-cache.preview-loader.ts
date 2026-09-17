import type { LibrarySource } from '../addressing/library-source';
import { parseAddress } from '../addressing/maple-address';
import type { FolderEntry } from '../folder-access/folder-access.types';
import type { AssetId } from '../models/asset';
import type { HostedPreviewResolver } from './hosted-preview-resolver.service';

export interface PreviewLoaderDeps {
  backend: 'hosted' | 'self-hosted';
  librarySource: Pick<LibrarySource, 'previewBlob'>;
  hostedPreview: Pick<HostedPreviewResolver, 'resolve'>;
  fileHandles: ReadonlyMap<AssetId, FolderEntry>;
  bytesForAsset: (id: AssetId) => Promise<Uint8Array>;
  hostedBytesSnapshotFor: (
    id: AssetId,
  ) => Promise<{ bytes: Uint8Array; source: { size: number; lastModified: number } }>;
  fsBrowse?: { getPreviewBlob: (absPath: string) => Promise<Blob | null> };
}

export function previewLoader(
  id: AssetId,
  deps: PreviewLoaderDeps,
): ((id: AssetId) => Promise<Blob | null>) | null {
  const isAddress = id.includes(':') && !id.startsWith('fs:');
  if (deps.backend === 'self-hosted') {
    if (isAddress) {
      return (assetId) => deps.librarySource.previewBlob(parseAddress(assetId));
    }
    if (id.startsWith('fs:') && typeof deps.fsBrowse?.getPreviewBlob === 'function') {
      return (assetId) => deps.fsBrowse!.getPreviewBlob(assetId.slice(3));
    }
    return null;
  }
  return (assetId) =>
    deps.hostedPreview.resolve(
      assetId,
      deps.bytesForAsset,
      (sourceId) => sourceIdentity(deps.fileHandles, sourceId),
      deps.hostedBytesSnapshotFor,
    );
}

async function sourceIdentity(
  fileHandles: ReadonlyMap<AssetId, FolderEntry>,
  id: AssetId,
): Promise<{ size: number; lastModified: number }> {
  const entry = fileHandles.get(id);
  if (!entry) throw new Error(`source identity unavailable for ${id}`);
  const file = await entry.getFile();
  return { size: file.size, lastModified: file.lastModified };
}
