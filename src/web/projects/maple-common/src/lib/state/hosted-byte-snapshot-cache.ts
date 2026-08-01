import type { FolderEntry } from '../folder-access/folder-access.types';
import type { AssetId } from '../models/asset';
import type { PreviewSourceIdentity } from '../maple-cache/preview-cache-protocol';
import { samePreviewSource } from '../maple-cache/preview-cache-protocol';
import type { LruCache } from './lru-cache';

export interface HostedByteSnapshot {
  bytes: Uint8Array;
  source: PreviewSourceIdentity;
}

/** Associates Hosted RAW byte buffers with the exact File snapshot that
 * produced them, preventing same-path replacements from reusing stale bytes. */
export class HostedByteSnapshotCache {
  readonly fileHandles = new Map<AssetId, FolderEntry>();
  private readonly identities = new Map<AssetId, PreviewSourceIdentity>();

  constructor(private readonly bytes: LruCache) {}

  register(id: AssetId, entry: FolderEntry): void {
    this.fileHandles.set(id, entry);
  }

  delete(id: AssetId): void {
    this.fileHandles.delete(id);
    this.identities.delete(id);
  }

  clear(): void {
    this.fileHandles.clear();
    this.identities.clear();
  }

  async identityFor(id: AssetId): Promise<PreviewSourceIdentity> {
    const file = await this.fileFor(id);
    return { size: file.size, lastModified: file.lastModified };
  }

  async snapshotFor(id: AssetId): Promise<HostedByteSnapshot> {
    const file = await this.fileFor(id);
    const source = { size: file.size, lastModified: file.lastModified };
    const cached = this.bytes.get(id);
    if (cached && samePreviewSource(this.identities.get(id) ?? invalidIdentity, source)) {
      return { bytes: cached, source };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    this.bytes.set(id, bytes);
    this.identities.set(id, source);
    return { bytes, source };
  }

  private async fileFor(id: AssetId): Promise<File> {
    const entry = this.fileHandles.get(id);
    if (!entry) throw new Error(`source snapshot unavailable for ${id}`);
    return entry.getFile();
  }
}

const invalidIdentity: PreviewSourceIdentity = { size: -1, lastModified: -1 };
