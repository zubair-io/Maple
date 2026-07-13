// .maple/ folder cache types — spec § 03.
// These mirror the spec's slice-10a schema. Do NOT add fields not defined here;
// extra fields break cross-product interop.

export type MapleGenerator = 'maple-syrup' | 'maple' | 'maple-native';

export interface MapleIndex {
  version: '1.0';
  generated: string; // ISO-8601 timestamp
  generator: MapleGenerator;
  assets: IndexedAsset[];
}

export interface IndexedAsset {
  filename: string; // primary RAW filename (e.g. "IMG_0001.CR3")
  size: number; // bytes
  mtime: number; // unix seconds (0 when unknown in fallback mode)
  /** First 16 hex chars of sha256(filename) — the cache-key stem. */
  sha256Prefix: string;
  thumbPath?: string; // './thumbs/<sha>.avif' if present (cache-only; not consulted for lookup)
  previewPath?: string; // './previews/<sha>.jpg' if present
  culling?: CullingState;
}

export interface CullingState {
  rating?: number; // 0..5
  flag?: 'pick' | 'reject';
  colorLabel?: 'red' | 'orange' | 'yellow' | 'green' | 'blue';
}
