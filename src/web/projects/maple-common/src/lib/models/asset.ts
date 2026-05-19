// Asset domain model — matches the shape used in _design-reference/lib/data.jsx.

export type AssetId = string;

export type Flag = 'unflagged' | 'pick' | 'reject';

export type ColorLabel = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | null;

export interface Asset {
  id: AssetId;
  filename: string;
  folderId: string;

  // Culling (mirrored on the sidecar).
  rating: number; // 0..5
  flag: Flag;
  colorLabel: ColorLabel;

  // Placeholder visual (gradient swatch until raw-wasm in P4).
  thumbnailGradient: string; // data-URI SVG

  // Justified-grid layout hint.
  aspectRatio: number; // width/height (e.g. 1.5 for 3:2 landscape)

  // Absolute filesystem path (Self-Hosted "browse by walking the filesystem"
  // path only — undefined for Hosted/imported assets). Used as the cache key
  // for /api/fs/thumb fetches and to identify the file on disk for byte loads.
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

  // IPTC
  title?: string;
  keywords?: string[];

  // GPS
  gps?: { lat: number; lon: number };
  city?: string;
  region?: string;
  country?: string;
}
