// Asset domain model — matches the shape used in _design-reference/lib/data.jsx.

export type AssetId = string;

export type Flag = 'unflagged' | 'pick' | 'reject';

export type ColorLabel = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | null;

/**
 * Structured vision metadata from the API's qwen2.5-vl describe stage.
 * Mirrors `ApiVision` in `bun-api-backend.service.ts`, kept here as a
 * standalone type so consumers outside the API client surface (offline
 * caches, view-model adapters) can hold a typed reference. `null` until
 * the describe stage has run on the asset.
 */
export interface Vision {
  caption: string;
  subjects: string[];
  sceneType: 'indoor' | 'outdoor' | 'aerial' | 'macro' | 'studio' | 'mixed';
  setting: string | null;
  activity: string | null;
  timeOfDay:
    | 'morning'
    | 'midday'
    | 'afternoon'
    | 'golden hour'
    | 'evening'
    | 'night'
    | 'unknown';
  lighting: 'natural' | 'artificial' | 'mixed' | 'low-light' | 'backlit' | 'flash';
  weather: 'clear' | 'cloudy' | 'rainy' | 'snowy' | 'foggy' | 'indoor' | 'unknown';
  mood: string;
  colors: string[];
  composition:
    | 'wide shot'
    | 'close-up'
    | 'portrait'
    | 'landscape'
    | 'aerial'
    | 'macro'
    | 'candid';
  textVisible: string | null;
  notableObjects: string[];
  shotType:
    | 'action'
    | 'static'
    | 'candid'
    | 'posed'
    | 'architectural'
    | 'nature'
    | 'event';
  indoorOutdoor: 'indoor' | 'outdoor';
}

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

  /** Structured vision metadata from the qwen2.5-vl describe stage.
   * `null`/missing on assets that haven't been through the stage yet
   * (paused on first boot, paid provider without a key, etc.). */
  vision?: Vision | null;
}
