/**
 * MongoDB schema types for Maple Self Hosted.
 *
 * Collections:
 *   - folders   : registered library roots
 *   - assets    : per-file metadata index (non-authoritative; sidecars are truth)
 *   - indexer_queue : pending background tasks
 *   - users, credentials, invites, refresh_tokens, challenges : auth (Phase A)
 */

import type { ObjectId, WithId } from 'mongodb';

// ---------------------------------------------------------------------------
// Folder
// ---------------------------------------------------------------------------

export interface FolderDoc {
  /** Absolute filesystem path to the library root. */
  path: string;
  /** Display label (defaults to basename of path). */
  label: string;
  /** When the last full scan completed (ISO string). */
  last_scan: string | null;
  /** Number of image files indexed during last scan. */
  file_count: number;
  /** When this record was created (ISO string). */
  created_at: string;
}

export type FolderWithId = WithId<FolderDoc>;

// ---------------------------------------------------------------------------
// Asset
// ---------------------------------------------------------------------------

/**
 * Camera/lens/exposure metadata extracted from EXIF (or RAW container) by the
 * indexer's exif stage. The whole subdocument is optional: a JPEG without EXIF
 * or a RAW format that exifr couldn't parse leaves `exif: null`.
 *
 * Fields are nullable individually so a partial parse (e.g. EXIF without GPS)
 * still persists what it found.
 */
export interface AssetExif {
  /** ISO 8601 — DateTimeOriginal (or CreateDate fallback). */
  captured_at: string | null;
  /** UTC year extracted from captured_at at index time. Stored as a
   * number so the timeline buckets endpoint can $group without parsing
   * the ISO string per-document. Null when captured_at is missing or
   * unparseable. */
  captured_year: number | null;
  /** UTC month (1..12) extracted from captured_at at index time.
   * Pairs with captured_year. */
  captured_month: number | null;
  /** Camera body manufacturer, e.g. "Hasselblad". */
  camera_make: string | null;
  /** Camera body model, e.g. "L3D-100c". */
  camera_model: string | null;
  /** Lens model string, e.g. "Hasselblad 24mm f/1.5". */
  lens: string | null;
  /** ISO speed. */
  iso: number | null;
  /** F-stop, e.g. 2.8. */
  aperture: number | null;
  /** Human-friendly shutter, e.g. "1/250" or "0.5". */
  shutter: string | null;
  /** Focal length in millimetres. */
  focal_length: number | null;
  /** Decimal-degree GPS pair (parsed by exifr). */
  gps: { lat: number; lng: number } | null;
}

/**
 * Structured photo-vision metadata emitted by the qwen2.5-vl describe stage.
 *
 * One JSON object per asset, produced by a single VLM pass over the 1280-px
 * preview. The fields are independently queryable so the UI can filter by
 * subject, scene, activity, etc. without first having to read free-text
 * captions.
 *
 * Versioned by `vision_meta.{model, prompt_version}`: bumping either causes
 * the runtime to invalidate stale rows and re-run the stage.
 *
 * Spec: `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`.
 */
export interface VisionDoc {
  /** 1–2 sentence caption focused on searchable content. Mirrors the
   * top-level `description` field; kept here so the structured doc is
   * self-contained. */
  caption: string;
  /** Categorical subject types: "person", "child", "adult", "dog", "cat",
   * "building", "vehicle", "landscape", "food", "plant", … Open vocabulary,
   * but the prompt guides the model toward common values. */
  subjects: string[];
  scene_type: 'indoor' | 'outdoor' | 'aerial' | 'macro' | 'studio' | 'mixed';
  /** Specific environment, e.g. "kitchen", "beach", "sports field".
   * Free-text but constrained by the prompt's examples. `null` when the
   * model cannot identify the setting. */
  setting: string | null;
  /** What is happening, e.g. "lacrosse", "cooking", "hiking". `null` for
   * a static scene with no action. */
  activity: string | null;
  time_of_day: 'morning' | 'midday' | 'afternoon' | 'golden hour' | 'evening' | 'night' | 'unknown';
  lighting: 'natural' | 'artificial' | 'mixed' | 'low-light' | 'backlit' | 'flash';
  weather: 'clear' | 'cloudy' | 'rainy' | 'snowy' | 'foggy' | 'indoor' | 'unknown';
  /** 1–3 words describing atmosphere. */
  mood: string;
  /** Dominant colors, max 5. */
  colors: string[];
  composition: 'wide shot' | 'close-up' | 'portrait' | 'landscape' | 'aerial' | 'macro' | 'candid';
  /** Any readable text in the image. `null` when there is none. The
   * describe stage mirrors this value into `ocr_text` and stamps
   * `ocr_meta.engine = "qwen2.5-vl"` on every run. */
  text_visible: string | null;
  /** Distinctive objects, max 8. */
  notable_objects: string[];
  shot_type: 'action' | 'static' | 'candid' | 'posed' | 'architectural' | 'nature' | 'event';
  indoor_outdoor: 'indoor' | 'outdoor';
  /** True when the image is a screenshot of a phone/computer/app UI
   * rather than a photograph. Canonical signal — the top-level
   * `AssetDoc.is_screenshot` mirrors this once the describe stage has
   * run, overwriting whatever the exif stage's filename heuristic
   * guessed first. */
  is_screenshot: boolean;
}

/**
 * Provenance for the `vision` subdoc.
 *
 * `prompt_version` is the lever used to invalidate stale rows when the
 * prompt copy changes — bump it in `workers/stages/describe.ts` and the
 * runtime will reprocess.
 */
export interface VisionMeta {
  /** Describe provider that produced this row. */
  provider: 'ollama' | 'anthropic' | 'openai' | 'gemini';
  /** Concrete model tag, e.g. "qwen2.5vl:7b". */
  model: string;
  /** Bumped whenever the system prompt changes. */
  prompt_version: number;
  generated_at: string;
  /** Bytes of the raw model response, post-fence-strip. Helps spot
   * truncation when triaging dead-letter rows. */
  raw_response_size: number;
}

/**
 * One known on-disk location for an asset. An asset may appear in multiple
 * places (same content backed up from two devices, or a copy under a
 * different folder); each location is one entry here.
 *
 * `path` is the directory relative to the library root, **POSIX-separated**
 * (`/` always — never `\`), no leading slash, no trailing slash. `""` means
 * the file sits at the library root. Matches the existing
 * `apple_rendered_path` and File Provider `relative_path` conventions.
 *
 * Writers must normalize `path.sep` → `/` before storing. The API runs on
 * Linux/macOS in production (where `path.sep === '/'` so the normalization
 * is a no-op), but enforcing POSIX in storage keeps the wire contract
 * portable for clients on every host.
 *
 * Readers MUST split on `/` (not `path.sep`) when reconstructing an
 * absolute path, then re-join with the platform separator via
 * `path.join`. The `assetAbsPath` helper does this; prefer it.
 *
 * Cache-path resolution uses `fileinfo[0]` as the canonical entry: thumbs
 * and previews live under `<library_root>/<fileinfo[0].path>/.maple/...`,
 * keyed by `maple_id`. Subsequent entries are alternate observations
 * discovered later. When the primary entry's library disappears, callers
 * walk the array and pick the first entry whose `library_id` still
 * resolves to a registered folder.
 *
 * `deleted_at` is per-entry so the asset row survives one location being
 * unlinked while another stays live. The asset is fully soft-deleted only
 * when every entry has `deleted_at` set.
 */
export interface FileInfo {
  /** Directory relative to the library root, POSIX-separated.
   * Examples: `"vacation/2024"`, `""` (file at library root). Never
   * contains `\` even on Windows hosts — writers normalize. */
  path: string;
  /** File name with extension, e.g. "IMG_001.dng". */
  filename: string;
  /** ObjectId of the registered folder this entry lives under. */
  library_id: ObjectId;
  /** ISO timestamp when this specific location was unlinked. Absent or
   * null when the entry is live. */
  deleted_at?: string | null;
}

export interface AssetDoc {
  /**
   * Known on-disk locations for this asset. Populated by the discover
   * watcher and backup-ingest. Length ≥ 1 for any live asset. Index 0
   * is the canonical entry used for cache-path resolution.
   *
   * Required for every live row. The pre-PR-7 boot-time backfill at
   * `db/migrations.ts` populated `fileinfo[0]` for legacy rows from the
   * now-retired `(folder_id, filename, abs_path)` fields; the pre-flight
   * gate in `client.ts` refuses to drop the legacy indexes until every
   * live row carries this field.
   *
   * Still typed as optional because soft-deleted rows from before the
   * backfill may exist (every entry with `deleted_at` set); readers
   * MUST tolerate `undefined` and skip / 404 when the field is missing.
   */
  fileinfo?: FileInfo[];
  /** File size in bytes from stat. */
  size: number;
  /** Last-modified epoch ms from stat. */
  mtime: number;
  /** Maple star rating 0-5 (from XMP sidecar). */
  rating: number;
  /** Pick flag: 1=pick, 0=none, -1=reject. */
  flag: -1 | 0 | 1;
  /** Color label string (red|yellow|green|blue|purple|""). */
  color_label: string;
  /**
   * Camera/lens/exposure metadata. Optional because backfill on existing rows
   * may not have run yet, and JPEGs without EXIF leave this null.
   */
  exif?: AssetExif | null;
  /** When this record was created (ISO string). */
  indexed_at: string;
  /**
   * Per-stage enrichment bookkeeping written by Phase 1's skeleton upsert and
   * patched by Phase 2+ workers. Optional because rows that pre-date the
   * skeleton schema may not have it; readers must default to "all stages
   * pending" when absent. See `docs/indexer-enrichment.md` §1.1, §2.
   */
  enrichment?: Enrichment;
  /** Reverse-geocoded place (Phase 2 geocode worker output). `null` until the
   * worker has run, or permanently `null` for assets without GPS. */
  place?: Place | null;
  /** Face detections (Phase 5 face worker output). `[]` until the worker has run. */
  faces?: AssetFaceDoc[];
  /** LLM-generated caption (Phase 6 describe worker output). `null` until run.
   * Free-text mirror of `vision.caption` once the structured vision stage has
   * run — duplicated so legacy clients reading `description` still work. */
  description?: string | null;
  /** True when this asset is a screenshot (phone/computer/app UI capture)
   * rather than a photograph. Set by the exif stage as a fast heuristic
   * (no camera_make + filename matches `Screenshot…` / `Screen Shot…`)
   * and then overwritten by the describe stage with the qwen2.5-vl
   * verdict, which handles cropped screenshots and photos-of-screens
   * the heuristic can't. Mirrors `vision.is_screenshot` once describe
   * has run; until then, the heuristic value stands. */
  is_screenshot?: boolean;
  /** Structured photo-vision metadata from the qwen2.5-vl describe stage.
   * `null` until the stage has run on this asset. See `VisionDoc`. */
  vision?: VisionDoc | null;
  /** Provenance of the `vision` subdoc. Carries the model + prompt version
   * so a config change automatically invalidates stale rows. */
  vision_meta?: VisionMeta | null;
  /** Recognised text extracted from the asset's preview, mirrored by the
   * describe stage from `vision.text_visible`. `null` until the describe
   * stage has run on this asset; empty string when the model saw no text. */
  ocr_text?: string | null;
  /** Provenance of the OCR mirror. The describe stage is the sole writer
   * and always stamps `engine: "qwen2.5-vl"`. The `"tesseract"` literal
   * remains in the union because production installs that were indexed
   * before #158 still carry rows with `engine: "tesseract"` until the
   * describe stage re-runs them; the API returns those values verbatim
   * (no read-side rewrite) so the wire contract must allow both. */
  ocr_meta?: {
    engine: 'qwen2.5-vl' | 'tesseract';
    engine_version: string;
    generated_at: string;
    /** Always `null` for the qwen2.5-vl path — the VLM has no per-token
     * confidence the way a classic OCR engine does. Legacy Tesseract
     * rows carry the engine's reported 0-100 mean confidence. */
    mean_confidence: number | null;
  } | null;
  /** Synthesised text-index target. Concatenation of `place.search_blob`,
   * `description`, and `ocr_text` — recomputed atomically inside each
   * worker's `complete()` so the value stays consistent without a
   * separate write. The Mongo `$text` index lives on this field
   * (Mongo allows only ONE text index per collection). */
  search_blob?: string;
  /** Per-device link from Apple Photos. Multiple entries when the same
   * content has been observed on more than one device. See
   * `.archived-plans/specs/2026-05-09-photokit-backup-design.md` §16. */
  phasset_links?: PhotoKitAssetLink[];
  /** Set when reconciliation observes the asset has been removed from Apple
   * Photos on every linked device. The cloud copy is preserved. */
  deleted_from_photos?: boolean;
  /** Relative path (under the library root) of the Apple-rendered companion,
   * when Apple Photos held edits at backup time. `null` for fresh originals. */
  apple_rendered_path?: string | null;
  /**
   * BLAKE3 hex of the canonical original bytes. Set by the backup ingest
   * endpoint; null/absent for assets indexed by other paths (the indexer
   * pipeline does not compute it — only the PhotoKit backup path does).
   * Used as the deduplication key when the same content arrives from
   * multiple devices.
   */
  maple_id?: string;
  /** True iff an XMP sidecar exists on disk next to this asset. Populated
   * by the XMP write/delete handlers (Phase 5b). Optional because legacy
   * rows pre-date the flag; readers should treat missing as `false`. */
  has_xmp?: boolean;
  /**
   * Soft-delete marker. Set by the discover watcher when a file vanishes
   * from disk (in which case `original_path` stays unset), AND by the
   * File Provider DELETE handler when a user drags an asset to Trash
   * (in which case `original_path` is also set). Trashed assets remain
   * indexed but are filtered out of folder listings and search results.
   */
  deleted_at?: string | null;
  /**
   * Pre-trash absolute path. Only set when a File Provider user
   * trashed the asset (distinct from a watcher-driven `removed`).
   * Read by the restore handler to compute the default target path,
   * and by `GET /api/folders/:id/trash` to surface the original
   * relative path to clients. Cleared on restore.
   */
  original_path?: string | null;
}

export type AssetWithId = WithId<AssetDoc>;

// ---------------------------------------------------------------------------
// Stage handler registry
// ---------------------------------------------------------------------------

/**
 * Per-stage handler routing. One row per stage that is allowed to be routed
 * to an external implementation. Today only `ai` is wired into the pipeline
 * (see `pipeline.runAi`); other stages ignore any rows that target them.
 *
 * `impl` is `"builtin"` to use the in-process default, or `"http"` to dispatch
 * the contract payload to an external endpoint (see
 * `src/api/src/handler-registry/`). All fields are snake_case to match the
 * rest of the schema.
 */
export interface StageHandlerDoc {
  /** Stage name. Today only "ai" is honoured. */
  stage: string;
  /** Implementation kind. */
  impl: 'builtin' | 'http';
  /** Required when impl === "http". POSTed the contract input. */
  url?: string;
  /** Override transport timeout. Defaults to 30 000 ms when absent. */
  timeout_ms?: number;
  /** When false, treated as if the row did not exist. */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Enrichment subdocument — `docs/indexer-enrichment.md` §2
// ---------------------------------------------------------------------------

/**
 * State carried per-stage on an asset. The fast pipeline seeds it with all
 * fields nulled (`done_at: null`, etc.) when the skeleton row is inserted;
 * Phase 2+ workers update it through their claim-and-complete loops.
 */
export interface EnrichmentStageState {
  /** ISO timestamp when the stage completed; `null` while pending. */
  done_at: string | null;
  /** Worker id holding the claim; `null` when available. */
  locked_by: string | null;
  /** Lease expiry (ISO timestamp); a crashed worker's claim auto-releases. */
  lease_expires_at: string | null;
  /** Retry counter; incremented on each failure. */
  attempts: number;
  /** Last error message, for triage. */
  last_error: string | null;
  /** Handler version that produced the output. Bumping it triggers re-runs. */
  version: number | null;
  /** ISO timestamp when the stage exhausted retries; `null` until then. */
  dead_letter_at: string | null;
}

export interface Enrichment {
  geocode: EnrichmentStageState;
  face: EnrichmentStageState;
  describe: EnrichmentStageState;
}

// ---------------------------------------------------------------------------
// Place — Phase 2 geocode worker output. Declared here so the type lives next
// to the asset shape, even though it stays `null` until Phase 2.
// `docs/indexer-enrichment.md` §4.4.
// ---------------------------------------------------------------------------

export interface PlaceAddress {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  /** Two-letter ISO 3166-2 subdivision code, e.g. "NY". */
  state_code?: string;
  postcode?: string;
  country?: string;
  /** Two-letter country code, lowercased, e.g. "us". */
  country_code?: string;
}

export interface PlacePoi {
  name: string;
  /** OSM category, e.g. "tourism", "amenity". */
  category: string;
  /** OSM type within the category, e.g. "museum", "park". */
  type: string;
}

export interface PlaceRollups {
  locality: string | null;
  region: string | null;
  country_code: string | null;
}

export interface Place {
  source: 'nominatim';
  geocoder_version: number;
  geocoded_at: string;
  lat: number;
  lon: number;
  display_name: string | null;
  address: PlaceAddress;
  pois: PlacePoi[];
  rollups: PlaceRollups;
  /** Denormalised text for full-text search (Phase 3). */
  search_blob: string;
}

// ---------------------------------------------------------------------------
// geocode_cache — Phase 2: quantised lat/lon → Place. Lets clustered photos
// at one location share a single Nominatim API call.
// `docs/indexer-enrichment.md` §4.3.
// ---------------------------------------------------------------------------

export interface GeocodeCacheDoc {
  /** Quantised key, e.g. `"lat:42.6526,lon:-73.7562"` (4 decimal places). */
  _id: string;
  place: Place;
  fetched_at: Date;
  geocoder_version: number;
}

// ---------------------------------------------------------------------------
// Face document — written by the Phase 5 face worker. Re-exported as
// `AssetFace` from `indexer/images.repo.ts` for the indexer-side callers.
// ---------------------------------------------------------------------------

/** Axis-aligned bounding box. Coordinate space is set by the producer
 * and documented at the use site — the face detector emits normalised
 * `[0,1]` proportions. Consumers must respect the documented units. */
export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AssetFaceDoc {
  /** Normalised `[0,1]` proportions of the source image — emitted by
   * the face detector (see `enrichment/face-detector.ts`). The web
   * `faceCropStyle` helper relies on these being proportions so the
   * CSS background-position percentages line up. */
  bbox: Bbox;
  person_id: string | null;
  confidence: number;
  /** Five identity-preserving landmarks (left eye, right eye, nose, left
   * mouth, right mouth) in normalised `[0,1]` coordinates, as emitted by
   * the SCRFD detector. Written by the `face-detect` stage and consumed by
   * `face-embed`, which feeds them to the recognizer's alignment step so a
   * re-embed reproduces the exact aligned crop detection produced — without
   * re-detecting.
   *
   * Optional for back-compat: legacy face docs (produced by the old single
   * `face` stage, which didn't persist landmarks) and operator-injected
   * fixtures omit it. When absent, `embedFace`'s alignment falls back to a
   * bbox-derived synthetic template (lower-quality embedding, but still in
   * the correct embedding space). */
  landmarks?: Array<{ x: number; y: number }>;
  embedding?: number[];
  /** Tag identifying which face-recognition model + alignment pipeline
   * produced `embedding`. Required on new writes; legacy rows without
   * this field are treated as `"mobilefacenet_v1"` (the v1 pipeline:
   * SCRFD-500m detector + MobileFaceNet recognizer + bbox-only crop).
   * The current pipeline tag is `"arcface_r100_glint360k_v1"`
   * (antelopev2: SCRFD-10G + ArcFace R100 trained on Glint360K +
   * landmark-aligned 112×112 crop).
   *
   * Written by the `face-embed` stage. A model swap is performed by
   * bumping that stage's `targetVersion`, which re-runs the recognizer on
   * every detected face through the normal worker loop and rewrites this
   * tag. Used by the clustering job to (eventually) gate which embeddings
   * can be compared in a single cosine search.
   *
   * Optional on the type because: (a) old documents predate the field,
   * and (b) operator-injected test fixtures sometimes omit it. Writers
   * inside this codebase always set it. */
  embedding_version?: string;
  /** Operator hid this face. Hidden faces are excluded from clustering
   * (so they don't get re-assigned to any person) and from every
   * person panel. `person_id` is forced to `null` on hide — the two
   * are written together by `hideFace`. */
  hidden?: boolean;
}

// ---------------------------------------------------------------------------
// People — face-cluster identities. Operator names a cluster; tagging two
// clusters with the same name merges them. See
// `src/api/src/people/people.repo.ts` for the merge semantics and
// `clustering-job.ts` for the online assignment loop.
// ---------------------------------------------------------------------------

export interface PersonDoc {
  /** Display name. Unique per database under a case-insensitive collation
   * (the unique index lives in `ensureIndexes`). The merge-on-duplicate
   * behaviour is enforced by `renamePerson`; the index is the safety net. */
  name: string;
  /** ISO timestamp the person row was first inserted. */
  created_at: string;
  /** ISO timestamp of the last write to this row (rename, cover update). */
  updated_at: string;
  /** Hex of the asset id whose thumbnail (with a CSS bbox crop) renders
   * as this person's cover image on the /people grid. Optional — when
   * absent the UI falls back to the person's initial. Was named
   * `cover_face_id` in an earlier draft; the rename clarifies that the
   * value is an asset _id, not a face _id (faces are sub-array entries
   * with no stable id of their own). */
  cover_asset_id?: string;
  /** Bbox of the cover face on the cover asset, in normalised `[0,1]`
   * proportions. Captured at the moment we picked the cover so the
   * `/api/people` list response can return a face-cropped thumbnail
   * without a second collection round-trip. Optional for backward
   * compatibility — `backfillCoverAssets` heals existing rows on the
   * next list call. */
  cover_bbox?: Bbox;
  /** When two clusters get the same name they merge: the orphan keeps
   * `merged_into` pointing at the survivor for an audit trail. Hidden
   * from the UI listing. The same field doubles as the soft-delete
   * marker — a row whose `merged_into` is set is excluded from
   * `listPeople`. */
  merged_into?: ObjectId | null;
  /** Centroid embedding (mean of assigned face embeddings). Refreshed
   * by `recomputeCentroids()` after each clustering run. Empty/undefined
   * for a brand-new person with no assignments yet. */
  centroid?: number[];
  /** Number of assigned faces at the time `centroid` was last refreshed.
   * Lets `runOnlineClustering` skip the recompute when nothing changed. */
  centroid_face_count?: number;
}

export type PersonWithId = WithId<PersonDoc>;

/**
 * Default empty state for one enrichment stage. The fast pipeline's skeleton
 * upsert seeds every stage with this shape on insert; readers fall back to it
 * when an old row pre-dates the `enrichment` subdocument.
 */
export function pendingStageState(): EnrichmentStageState {
  return {
    done_at: null,
    locked_by: null,
    lease_expires_at: null,
    attempts: 0,
    last_error: null,
    version: null,
    dead_letter_at: null,
  };
}

/** Default skeleton for the enrichment subdocument: all stages pending. */
export function pendingEnrichment(): Enrichment {
  return {
    geocode: pendingStageState(),
    face: pendingStageState(),
    describe: pendingStageState(),
  };
}

/**
 * Read-side normaliser: returns an `Enrichment` object even when the stored
 * doc has a missing/partial `enrichment` field. Per-stage fields default to
 * the same pending shape that the writer uses on insert, so old rows look
 * indistinguishable from freshly-skeletoned ones.
 */
export function normaliseEnrichment(raw: Partial<Enrichment> | undefined | null): Enrichment {
  return {
    geocode: { ...pendingStageState(), ...(raw?.geocode ?? {}) },
    face: { ...pendingStageState(), ...(raw?.face ?? {}) },
    describe: { ...pendingStageState(), ...(raw?.describe ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Indexer queue task
// ---------------------------------------------------------------------------

export type TaskKind = 'scan_folder' | 'gen_thumb' | 'extract_exif';

export interface IndexerTaskDoc {
  kind: TaskKind;
  /** Payload varies by task kind. */
  payload: Record<string, unknown>;
  /** Lifecycle: pending → processing → done | failed. */
  status: 'pending' | 'processing' | 'done' | 'failed';
  /** Error message when status === "failed". */
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type IndexerTaskWithId = WithId<IndexerTaskDoc>;

// ---------------------------------------------------------------------------
// JobRunner — sibling subsystem to the indexer pipeline for user-triggered
// long-running work (export, batch reprocess, …). See
// `docs/workers-architecture.md` §9, §11. Persisted job documents with
// progress reporting, atomic claim-and-lease (mirrors the geocode worker),
// and cooperative cancellation.
// ---------------------------------------------------------------------------

/** Job kinds the runner knows how to dispatch. Add new kinds by extending
 * this union and registering a handler in `job-runner/handlers/index.ts`. */
export type JobKind = 'batch_jpeg_export';

/** Lifecycle: queued → running → (done | failed | cancelled).
 * `cancelled` is set when a running job observes `cancel_requested` between
 * progress steps and exits cleanly. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobDoc {
  kind: JobKind;
  status: JobStatus;
  /** Job-specific input. Schema is per-kind and validated by the handler. */
  payload: Record<string, unknown>;
  /** Coarse progress tick. `total` is set by the handler on first
   * progress report; renderers may show indeterminate state until then. */
  progress: { current: number; total: number };
  /** Populated on `done`. Shape is per-kind. */
  result: Record<string, unknown> | null;
  /** Last error message when status === "failed". */
  error: string | null;
  /** Worker id holding the claim; null when available. */
  locked_by: string | null;
  /** Lease expiry (ISO timestamp). A crashed worker's claim auto-releases
   * once `now() > lease_expires_at` so a sibling instance can re-claim. */
  lease_expires_at: string | null;
  /** Cancellation flag. Routes flip this; the handler observes it between
   * progress steps and exits cleanly. */
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

export type JobWithId = WithId<JobDoc>;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export type UserRole = 'owner' | 'member';

export interface UserDoc {
  email: string; // unique, lowercased
  role: UserRole;
  created_at: string;
  last_seen_at: string | null;
}
export type UserWithId = WithId<UserDoc>;

// ---------------------------------------------------------------------------
// Credential (one user → many passkeys)
// ---------------------------------------------------------------------------

export interface CredentialDoc {
  user_id: ObjectId;
  credential_id: string; // base64url, unique
  public_key: Buffer; // COSE key
  counter: number;
  transports: string[];
  device_label: string;
  created_at: string;
  last_used_at: string | null;
}
export type CredentialWithId = WithId<CredentialDoc>;

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

export interface InviteDoc {
  code: string; // 8-char base32, unique
  email: string; // lowercased
  invited_by: ObjectId;
  expires_at: Date; // TTL — MUST be a Date (TTL monitor ignores ISO strings)
  consumed_at: string | null;
}
export type InviteWithId = WithId<InviteDoc>;

// ---------------------------------------------------------------------------
// Refresh token
// ---------------------------------------------------------------------------

export interface RefreshTokenDoc {
  user_id: ObjectId;
  token_hash: string; // sha256(raw)
  issued_at: string;
  expires_at: Date; // TTL — MUST be a Date (TTL monitor ignores ISO strings)
  revoked_at: string | null;
  replaced_by: ObjectId | null;
  device_label: string;
}
export type RefreshTokenWithId = WithId<RefreshTokenDoc>;

// ---------------------------------------------------------------------------
// WebAuthn challenge (5-min TTL)
// ---------------------------------------------------------------------------

export type ChallengePurpose = 'register' | 'authenticate' | 'add_credential';

export interface ChallengeDoc {
  challenge: string; // base64url
  purpose: ChallengePurpose;
  user_id: ObjectId | null;
  email: string | null;
  invite_code: string | null;
  expires_at: Date; // TTL — MUST be a Date (TTL monitor ignores ISO strings)
}
export type ChallengeWithId = WithId<ChallengeDoc>;

// ---------------------------------------------------------------------------
// PhotoKit backup
// ---------------------------------------------------------------------------

/** One link between a stored asset and an Apple Photos PHAsset on a specific
 * device. An asset may have multiple links when the same content was backed
 * up from more than one device. */
export interface PhotoKitAssetLink {
  device_id: string;
  /** Apple's `PHAsset.localIdentifier`, e.g. "BFBBE32B-2C39-43A5-B7FC-1E9BC0577CFE/L0/001".
   * Per-device — different on every device for the same iCloud photo. */
  phasset_local_id: string;
  /** Apple's `PHCloudIdentifier.stringValue` — stable across every device
   * signed into the same iCloud Photos account. Absent when the device
   * doesn't have iCloud Photos enabled, or PhotoKit couldn't resolve a
   * cloud id at upload time. Used as the cross-device join key by the
   * merged timeline so a photo backed up from one device shows
   * `.synced` on every other device that has the same photo locally. */
  phasset_cloud_id?: string;
  first_seen: Date;
}

/** One in-flight or resumable upload. Resume key is
 * (library_id, device_id, phasset_local_id) — all known at enqueue. */
export interface UploadSessionDoc {
  _id: ObjectId;
  library_id: ObjectId;
  device_id: string;
  phasset_local_id: string;
  /** Target path under the library root, decided by the device pre-upload. */
  target_rel_path: string;
  total_bytes: number;
  received_bytes: number;
  chunk_size: number;
  /** Sessions older than 7d in "open" get GC'd by the TTL monitor. */
  state: 'open' | 'completed' | 'abandoned';
  /** TTL — Date (not string) so the Mongo TTL monitor can prune abandoned sessions older than 7d. */
  created_at: Date;
  /** Bumped on every chunk; same TTL semantics as `created_at`. */
  updated_at: Date;
  /** Set on the final chunk; used for dedup against existing AssetDoc rows. */
  maple_id?: string;
  /** Apple PHCloudIdentifier — stable across every device on the same iCloud
   * Photos account. When two devices both have iCloud Photos enabled and try
   * to back up the same photo, their sessions share this id (their
   * phasset_local_id differs). openOrResume uses this for cross-device
   * conflict detection so two devices don't race uploading the same asset. */
  phasset_cloud_id?: string;
}

export type UploadSessionWithId = WithId<UploadSessionDoc>;

/** Per-device, per-library progress summary. NOT TTL-pruned — backup
 * sessions are kept indefinitely so the device can report cumulative state. */
export interface BackupSessionDoc {
  _id: ObjectId;
  library_id: ObjectId;
  device_id: string;
  started_at: Date;
  last_progress_at: Date;
  total_count: number;
  uploaded_count: number;
  failed_count: number;
}

export type BackupSessionWithId = WithId<BackupSessionDoc>;

// ---------------------------------------------------------------------------
// Asset change feed (Phase 5b — File Provider push channel)
// ---------------------------------------------------------------------------

export type AssetChangeKind = 'create' | 'update' | 'delete' | 'restore';

export interface AssetChangeDoc {
  /** Monotonically increasing per insert. Allocated via the
   * server_state.next_cursor counter (see ServerStateDoc). */
  cursor: number;
  asset_id: ObjectId | null;
  folder_id: ObjectId | null;
  kind: AssetChangeKind;
  /** Absolute filesystem path of the affected asset. Null for changes
   * that don't have a single canonical path (e.g. a folder rescan). */
  abs_path: string | null;
  /**
   * Path of the affected asset relative to its containing library root
   * (`folder.path`). Computed at write time by
   * `recordAndPublishAssetChange` so File Provider clients can route
   * per-folder invalidation precisely instead of falling back to the
   * working-set. `""` when the absPath equals the folder root itself.
   * `null` when the field is absent (rows written before Phase 6) OR
   * when the absPath doesn't fall under the named folder root
   * (defensive — the writer logs and stores null rather than emitting
   * a wrong path). Readers MUST tolerate null.
   */
  relative_path: string | null;
  /** Insertion timestamp — informational. The cursor is the source of
   * truth for ordering. */
  at: Date;
}

export type AssetChangeWithId = WithId<AssetChangeDoc>;

/**
 * A small key/value collection for server-wide counters. Today the only
 * key in use is `_id: "asset_changes_cursor"`, holding the next cursor
 * value to allocate.
 */
export interface ServerStateDoc {
  _id: string;
  /** For the asset_changes counter row: the most recently allocated
   * cursor. The next allocation atomically `$inc`'s this and returns
   * the new value. */
  seq?: number;
}

export type ServerStateWithId = WithId<ServerStateDoc>;
