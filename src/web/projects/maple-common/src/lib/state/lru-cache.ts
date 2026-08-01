import { AssetId } from '../models/asset';

// ── LRU cache ─────────────────────────────────────────────────────────────────

/**
 * Simple LRU cache keyed by AssetId, evicting by total byte count.
 * Uses Map insertion order as a recency queue (delete-and-reinsert on access).
 */
export class LruCache {
  private entries = new Map<AssetId, Uint8Array>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(id: AssetId): Uint8Array | undefined {
    const v = this.entries.get(id);
    if (v) {
      // Refresh recency by reinserting at the end.
      this.entries.delete(id);
      this.entries.set(id, v);
    }
    return v;
  }

  set(id: AssetId, bytes: Uint8Array): void {
    if (this.entries.has(id)) {
      this.totalBytes -= this.entries.get(id)!.byteLength;
      this.entries.delete(id);
    }
    this.entries.set(id, bytes);
    this.totalBytes += bytes.byteLength;
    this._evict();
  }

  delete(id: AssetId): void {
    const removed = this.entries.get(id);
    if (!removed) return;
    this.entries.delete(id);
    this.totalBytes -= removed.byteLength;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private _evict(): void {
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as AssetId;
      const removed = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.totalBytes -= removed.byteLength;
    }
  }
}

// ── Thumbnail LRU cache ───────────────────────────────────────────────────────

/**
 * Count-bounded LRU cache for thumbnail URLs (blob: or plain HTTPS strings).
 * Uses Map insertion order as a recency queue (delete-and-reinsert on access).
 * Revokes `blob:` URLs when entries are evicted or the cache is cleared so
 * Blob bytes are freed promptly rather than waiting for a folder switch.
 *
 * Default capacity: 500 thumbnails. At 10-30 kB each this stays well inside
 * a comfortable memory envelope even on a 5,000-image folder. Folder switch
 * used to wipe the entire map; with this LRU, recently-viewed thumbnails from
 * the previous folder stay warm until displaced by newer ones (M2, #1327).
 */
export class ThumbLruCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxCount: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(id: string): string | undefined {
    const v = this.entries.get(id);
    if (v !== undefined) {
      // Refresh recency by reinserting at the end.
      this.entries.delete(id);
      this.entries.set(id, v);
    }
    return v;
  }

  set(id: string, url: string, onEvict?: (evictedId: string) => void): void {
    if (this.entries.has(id)) {
      // Revoke the previous blob: URL before replacing so we don't leak
      // the old Blob object — the caller won't hold a reference to it.
      const prev = this.entries.get(id)!;
      if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      this.entries.delete(id);
    }
    this.entries.set(id, url);
    this._evict(onEvict);
  }

  /** Revoke all blob URLs and empty the cache. */
  clearAll(): void {
    for (const url of this.entries.values()) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    }
    this.entries.clear();
  }

  /** Snapshot as a plain Map for the Angular signal. */
  toMap(): Map<string, string> {
    return new Map(this.entries);
  }

  private _evict(onEvict?: (evictedId: string) => void): void {
    while (this.entries.size > this.maxCount) {
      const oldest = this.entries.keys().next().value as string;
      const url = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      onEvict?.(oldest);
    }
  }
}
