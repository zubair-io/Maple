// Asset domain model — matches the shape used in _design-reference/lib/data.jsx.

export type AssetId = string;

export type Flag = 'unflagged' | 'pick' | 'reject';

export type ColorLabel = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | null;

/**
 * Canonical on-disk location record for an asset. Mirrors
 * `AssetDoc.fileinfo[]` on the server (`src/api/src/db/schema.ts`).
 *
 * Field names are snake_case to match the wire format (the server ships the
 * BSON doc through verbatim). `path` is POSIX-separated regardless of host;
 * web clients are always POSIX so consumers can join with `/`.
 *
 * Multiple entries are alternate observations of the same asset; entry 0 is
 * canonical for path / cache resolution. `deleted_at` is per-entry so the
 * asset row survives one location being unlinked while another stays live.
 */
export interface FileInfo {
  /** Directory relative to the library root, POSIX-separated. `""` for
   *  files at the library root. */
  path: string;
  /** File name with extension, e.g. `"IMG_001.dng"`. */
  filename: string;
  /** Hex ObjectId of the registered library this entry lives under. */
  library_id: string;
  /** ISO timestamp when this specific location was unlinked. Absent or
   *  null when the entry is live. */
  deleted_at?: string | null;
}

export interface Asset {
  id: AssetId;
  filename: string;
  folderId: string;

  // Culling (mirrored on the sidecar).
  rating: number; // 0..5
  flag: Flag;
  colorLabel: ColorLabel;
  hidden?: boolean;
  hidden_reason?: 'manual' | 'nudity' | 'nudity-burst';
  hidden_ack?: boolean;

  // Placeholder visual (gradient swatch until raw-wasm in P4).
  thumbnailGradient: string; // data-URI SVG

  // Justified-grid layout hint.
  aspectRatio: number; // width/height (e.g. 1.5 for 3:2 landscape)

  /**
   * Canonical on-disk locations for content-addressed Self-Hosted assets.
   * Populated by the server's discover watcher and backup-ingest. Resolve
   * the on-disk path via `assetAbsPath(asset, libraries)` from
   * `lib/state/library-store.service.ts`.
   */
  fileinfo?: FileInfo[];

  /**
   * Client-synthesised absolute path for Self-Hosted *fs-walk* browse mode
   * (NOT from the wire). The fs-walk path lets the editor mount on a
   * deep-link `/edit/fs:<absPath>` without first navigating via Browse;
   * `hydrateSelfHostedFsAsset` populates it from the route id, and
   * `_applyFsListing` sets it from `FsDirListing` entries (also a path,
   * not a content-addressed location).
   *
   * NOT to be confused with the retired server-side `abs_path` field; the
   * wire contract uses `fileinfo[]` exclusively for content-addressed
   * assets. This field stays on the client model because the fs-walk
   * browse mode is orthogonal to the content-addressing migration.
   */
  absPath?: string;

  // Metadata (for Info tab).
  width?: number;
  height?: number;
  camera?: string;
  lens?: string;
  focalLength?: string; // "50mm"
  aperture?: string; // "f/2.8"
  shutter?: string; // "1/250"
  iso?: number;
  capturedAt?: string; // ISO string / readable date
  edited?: boolean;
  /** File size in bytes (from server stat or FS Access API). */
  size?: number;
  /** Last-modified time (ISO 8601 string). */
  mtime?: string;

  /** True when the asset is a video file. Batch-metadata path is unchanged
   *  (server detects extension); this field is for UI badges. */
  isVideo?: boolean;

  // IPTC
  title?: string;
  keywords?: string[];

  // GPS
  gps?: { lat: number; lon: number };
  city?: string;
  region?: string;
  country?: string;
}
