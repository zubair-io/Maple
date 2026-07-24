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

/**
 * A backup/mirror location for a library. Every durable write or move the
 * server performs under the library's primary `path` is replicated to each
 * enabled mirror root (see `fs/mirrored.ts` + `fs/mirror-registry.ts`). The
 * mirror holds a shadow of the primary's originals and XMP sidecars, so it can
 * stand in as a recovery source if the primary disk is lost. The derived
 * `.maple/` thumbnail/preview cache is NOT replicated yet (those bytes are
 * written out-of-band by FFI / a child process); mirroring the cache and
 * serving reads from the mirror are tracked in the read-replica follow-up (#926).
 */
export interface MirrorLocation {
  /** Absolute filesystem path to the mirror root. */
  path: string;
  /** When false, replication to this mirror is paused — the operator can
   * disable a mirror whose disk is offline without losing the configuration.
   * (Reads are always served from the primary today; mirror read failover is
   * the read-replica follow-up, #926.) */
  enabled: boolean;
}

/**
 * One pending file copy to a mirror, in the `mirror_queue` collection. The
 * detect/copy split: the mirror-scan detector and the inline `onMirrorFailure`
 * sink only *enqueue* rows here (cheap); the mirror copy worker drains them
 * (claim → copy → complete/retry). `mirror_path` is the natural key — one
 * pending copy per destination — so re-detection and repeated failures
 * coalesce instead of duplicating.
 */
export interface MirrorQueueDoc {
  /** Absolute path of the committed primary file to replicate. */
  primary_path: string;
  /** Absolute destination path under the mirror root. */
  mirror_path: string;
  /** Why it was enqueued — diagnostics only. */
  reason: 'scan-missing' | 'write-failure';
  /** Claim lease: epoch-ms the current claim expires, or null when free. */
  claimed_at: number | null;
  /** Failed-copy retry count. */
  attempts: number;
  /** Last failure message, or null. */
  last_error: string | null;
  /** Parked after `attempts` exceeds the max — operator-recoverable. */
  dead: boolean;
  /** When first enqueued (epoch-ms); the claim sort key (oldest first). */
  enqueued_at: number;
}

export interface FolderDoc {
  /** Absolute filesystem path to the library root. */
  path: string;
  /** Stable public identifier, [a-z0-9-]. Minted once at registration,
   * never auto-changes (the human label may change freely). Guaranteed
   * present on all rows: boot STOPs (rethrows) if backfillFolderSlugs
   * fails, so the unique index is never created over null slugs. */
  slug: string;
  /** Display label (defaults to basename of path). */
  label: string;
  /** When the last full scan completed (ISO string). */
  last_scan: string | null;
  /** Number of image files indexed during last scan. */
  file_count: number;
  /** When this record was created (ISO string). */
  created_at: string;
  /** Backup/mirror locations for this library. Absent or empty ⇒ no
   * mirroring (the historical single-location behaviour). Writes/moves fan
   * out to every enabled entry; reads may load-balance across them. */
  mirrors?: MirrorLocation[];
}

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
 * Structured photo-vision metadata emitted by the qwen3-vl describe stage.
 *
 * One JSON object per asset, produced by a single VLM pass over the 1280-px
 * preview. The fields are independently queryable so the UI can filter by
 * subject, scene, activity, etc. without first having to read free-text
 * captions.
 *
 * Versioned by `vision_meta.{model, prompt_version}`: bumping either causes
 * the runtime to invalidate stale rows and re-run the stage.
 *
 * Prompt v5 asks the model to classify `is_screenshot` and `nudity` before
 * every other field (grammar-constrained decode follows schema property
 * order — see `VISION_DOC_JSON_SCHEMA` in `parse-vision-json-enums.ts`), and
 * short-circuits the scene-descriptive fields to `null` when
 * `is_screenshot` is true. That is why `scene_type`, `time_of_day`,
 * `lighting`, `weather`, `composition`, and `shot_type` are nullable here —
 * they are always populated for photographs and always `null` for
 * screenshots.
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
  /** `null` when `is_screenshot` is true (v5 screenshot short-circuit). */
  scene_type: 'indoor' | 'outdoor' | 'aerial' | 'macro' | 'studio' | 'mixed' | null;
  /** Specific environment, e.g. "kitchen", "beach", "sports field".
   * Free-text but constrained by the prompt's examples. `null` when the
   * model cannot identify the setting, or when `is_screenshot` is true. */
  setting: string | null;
  /** What is happening, e.g. "lacrosse", "cooking", "hiking". `null` for
   * a static scene with no action, or when `is_screenshot` is true. */
  activity: string | null;
  /** `null` when `is_screenshot` is true (v5 screenshot short-circuit). */
  time_of_day:
    | 'morning'
    | 'midday'
    | 'afternoon'
    | 'golden hour'
    | 'evening'
    | 'night'
    | 'unknown'
    | null;
  /** `null` when `is_screenshot` is true (v5 screenshot short-circuit). */
  lighting:
    | 'natural'
    | 'artificial'
    | 'mixed'
    | 'low-light'
    | 'backlit'
    | 'flash'
    | 'unknown'
    | null;
  /** `null` when `is_screenshot` is true (v5 screenshot short-circuit). */
  weather: 'clear' | 'cloudy' | 'rainy' | 'snowy' | 'foggy' | 'indoor' | 'unknown' | null;
  /** 1–3 words describing atmosphere. */
  mood: string;
  /** Dominant colors, max 5. */
  colors: string[];
  /** `null` when `is_screenshot` is true (v5 screenshot short-circuit).
   * `'candid'` was removed from the enum in v5 — it's a shot-type concept
   * and the models frequently confused it with `shot_type`'s own
   * `'candid'` value; see `COMPOSITION_SYNONYMS`. */
  composition: 'wide shot' | 'close-up' | 'portrait' | 'landscape' | 'aerial' | 'macro' | null;
  /** Any readable text in the image, transcribed verbatim (case + line
   * order preserved). `null` when there is none. The describe stage
   * mirrors this value into `ocr_text` and stamps
   * `ocr_meta.engine = "qwen2.5-vl"` on every run — it is the sole OCR
   * source since the parallel Tesseract stage was removed in #158. */
  text_visible: string | null;
  /** Distinctive objects, max 8. */
  notable_objects: string[];
  /** `null` when `is_screenshot` is true (v5 screenshot short-circuit). */
  shot_type: 'action' | 'static' | 'candid' | 'posed' | 'architectural' | 'nature' | 'event' | null;
  /** True when the image is a screenshot of a phone/computer/app UI
   * rather than a photograph. Canonical signal — the top-level
   * `AssetDoc.is_screenshot` mirrors this once the describe stage has
   * run, overwriting whatever the exif stage's filename heuristic
   * guessed first. */
  is_screenshot: boolean;
  /** Nudity classification ladder (prompt v5). `'explicit'` covers exposed
   * genitals/buttocks/female breasts (incl. art, statues, on-screen
   * content); `'suggestive'` covers sexualized posing or underwear/
   * lingerie-focused framing without exposure; `'none'` covers everything
   * else, including swimwear, shirtless men, and ordinary family bath/beach
   * photos. Canonical AI signal — the top-level `AssetDoc.hidden` is set
   * (never cleared) when this is `'explicit'`, unless an explicit user
   * override says otherwise. See `AssetDoc.hidden` and
   * `sidecar-metadata-index.ts`'s `nativeHidden`. */
  nudity: 'none' | 'suggestive' | 'explicit';
  /** @deprecated Superseded by `nudity` in prompt v5. Rows written under
   * `prompt_version` <= 4 carry this instead of `nudity`; the
   * targetVersion-6 describe re-run rewrites them. Readers must handle
   * both fields until every row has been re-captioned. */
  nudity_detected?: boolean;
  /** @deprecated Dropped in prompt v5 — fully derivable from `scene_type`.
   * Rows written under `prompt_version` <= 4 carry this; the
   * targetVersion-6 describe re-run drops it. Readers must handle its
   * absence. */
  indoor_outdoor?: 'indoor' | 'outdoor';
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
  /** Concrete model tag, e.g. "qwen3-vl:8b". */
  model: string;
  /** Bumped whenever the system prompt changes. */
  prompt_version: number;
  generated_at: string;
  /** Bytes of the raw model response, post-fence-strip. Helps spot
   * truncation when triaging dead-letter rows. */
  raw_response_size: number;
}

export interface TranscriptSegmentDoc {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptDoc {
  text: string;
  segments: TranscriptSegmentDoc[];
  language: string;
  model: string;
  duration_sec: number | null;
  generated_at: string;
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
 * Per-entry liveness is the source of truth for the whole asset's
 * visibility. An entry is **live** when it has neither `deleted_at` (its
 * bytes were replaced by different content — see the modified-content guard
 * in `discover/handle-event.ts`) nor `missing_since` (its file vanished from
 * disk). The asset row survives one location going non-live while another
 * stays live; it is hidden from reads and parked out of stage claims only
 * when *every* entry is non-live. See `isLiveFileInfo` /
 * `liveFileInfoElemMatch` in `indexer/images.repo.ts`.
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
  /** ISO timestamp when this specific location stopped holding this asset's
   * content (its bytes were replaced in place by a different file). Absent or
   * null when the entry is live. Set by the modified-content guard. The
   * missing-reaper treats a `deleted_at` entry as dead — it does NOT re-stat
   * the path (a different file may now sit there), it just prunes it after the
   * cooldown. */
  deleted_at?: string | null;
  /** ISO timestamp when this specific location's file was found GONE from
   * disk (ENOENT) — set by the discover `removed` handler and by a
   * file-touching stage that ENOENTs on this path. Absent or null when the
   * entry is live. This is the per-location "pending delete" tag the
   * missing-reaper consumes: it re-stats the path (recovering the entry if the
   * file reappears), and once the entry has been missing past the prune
   * window it `$pull`s the entry — deleting the whole record when no other
   * entry remains. Replaces the former root-level `missing_since`. */
  missing_since?: string | null;
  /** Structured provenance for `missing_since` (#2171): which writer tagged
   * this entry non-live, e.g. `"watch-removed"` (discover removed handler),
   * `"stage-enoent:<stage>"` (a file-touching stage's confirmed ENOENT),
   * `"dedupe-absent"` (DeDuplicate found the copy gone), `"content-changed"`
   * (the modified-content guard's orphan dual-flag). Purely diagnostic — no
   * reader branches on it — and cleared wherever `missing_since` is cleared,
   * so a false-positive tag can always be traced back to its source. */
  missing_reason?: string | null;
  /** True when this location sits in a folder the operator marked to keep —
   * a `.keep` marker file present in the same directory at index time (see
   * `KEEP_FILENAME` / `directoryHasKeepFile` in `fs/duplicates.ts`). The
   * DeDuplicate worker never relocates a kept copy: when any live copy of an
   * asset is kept, every kept copy survives and only the un-kept duplicates are
   * collapsed into `_duplicates/`. Absent/false ⇒ ordinary keeper ranking
   * applies. The flag is recorded at discover time for visibility, but the
   * worker re-confirms the `.keep` file on disk before acting (the marker can be
   * added or removed after a file was first indexed). */
  keep?: boolean;
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
   * and then overwritten by the describe stage with the qwen3-vl
   * verdict, which handles cropped screenshots and photos-of-screens
   * the heuristic can't. Mirrors `vision.is_screenshot` once describe
   * has run; until then, the heuristic value stands. */
  is_screenshot?: boolean;
  /**
   * Authoritative hidden flag, read by every browse/search/badge surface.
   * Set either by explicit user action (via the XMP `papp:Hidden`
   * override — see `MetadataOverride.hidden`) or by the describe stage's
   * nudity verdict (`vision.nudity === 'explicit'`, with a legacy
   * `vision.nudity_detected === true` fallback for stale v4 rows;
   * `'suggestive'` does not hide). `sidecar-metadata-index` projects the
   * effective value: an explicit override always wins; absent an
   * override, the value is `priorHidden || explicitNudity` — deliberately
   * one-directional. A later describe re-run whose verdict is not
   * `'explicit'` must never silently un-hide an asset a user hid
   * manually, or one a prior AI pass correctly flagged; only an explicit
   * user override can turn `hidden` back to `false`. Optional because
   * legacy rows pre-date the field; readers must treat missing as
   * `false`.
   */
  hidden?: boolean;
  /** Why `hidden` is currently true. `'manual'` when the user explicitly
   * hid it (an XMP override is present); `'nudity'` when the describe
   * stage's own vision verdict set it; `'nudity-burst'` when it was
   * propagated from a sibling asset in the same burst (see
   * `enrichment/burst-siblings.ts`). Absent when not hidden. A manual
   * reason is never overwritten by a later AI pass. */
  hidden_reason?: 'manual' | 'nudity' | 'nudity-burst';
  /** Operator has reviewed an AI-driven hide (`hidden_reason` is
   * `'nudity'` or `'nudity-burst'`). `false` immediately after an
   * automatic hide; flips to `true` via `POST /api/assets/:id/hidden-ack`
   * once the operator has seen it in the "newly hidden" review list.
   * Meaningless for `hidden_reason: 'manual'` — never set for those. */
  hidden_ack?: boolean;
  /** Structured photo-vision metadata from the qwen3-vl describe stage.
   * `null` until the stage has run on this asset. See `VisionDoc`. */
  vision?: VisionDoc | null;
  /** Provenance of the `vision` subdoc. Carries the model + prompt version
   * so a config change automatically invalidates stale rows. */
  vision_meta?: VisionMeta | null;
  /** Recognised text extracted from the asset's preview, mirrored by the
   * describe stage from `vision.text_visible`. `null` until the describe
   * stage has run on this asset; empty string when the model saw no text. */
  ocr_text?: string | null;
  /** Derived speech-to-text data. Stored in Mongo only, never XMP. */
  transcript?: TranscriptDoc;
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
   * Backup folder-layout generation this asset has been placed into, stamped by
   * the refile-backups cleanup (`workers/migration/refile-backups.ts`) as its
   * done-marker — NOT a correctness oracle. `3` once that migration has filed the
   * asset into the canonical layout (`<year>/Screenshot`, or
   * `<year>/<State|Country>/<Town/City||Place>`, or the `<year>/<MM>` fallback)
   * computed from its current data. Generations 1 (pre-geo flat, #744, never
   * stamped) and 2 (the old geo migration, which could freeze an asset stamped on
   * a no-op before its geocode resolved) are superseded; the cleanup selects on
   * `{ $ne: N }` (N = current generation) so the whole backlog re-sweeps exactly
   * once per bump. Only backup-origin assets carry it.
   */
  backup_layout_version?: number;
  /**
   * Video-metadata backfill generation (`workers/migration/backfill-video-exif.ts`).
   * Stamped once that migration has read a video's QuickTime `moov` capture date +
   * GPS into `exif` (#1525); its `{ $ne: N }` selector re-sweeps videos once per
   * bump. Only set on backup-origin video assets.
   */
  video_meta_version?: number;
  /**
   * Video poster re-arm generation (`workers/migration/rearm-video-posters.ts`).
   * Stamped once that migration has reset a video's thumb/preview/describe/face
   * stage versions so poster-frame rendering (#1649) can pick it up; its
   * `{ $ne: N }` selector re-sweeps videos once per bump. Without this marker
   * the candidate set would refill as soon as the thumb stage re-stamped the
   * asset and the migration would never reach "done."
   */
  video_poster_rearm_version?: number;
  /**
   * Preview-missing re-drive generation
   * (`workers/migration/redrive-preview-missing-describe.ts`). Stamped once
   * that migration has reset a row's describe stage after it was terminally
   * skipped with `skip: preview-missing` pre-#2177; its `{ $ne: N }` selector
   * re-sweeps once per bump. Without this marker a row that legitimately
   * re-skips under the new code (terminal video case writes the same string)
   * would re-enter the candidate set and the migration would loop forever.
   */
  preview_missing_redrive_version?: number;
  /**
   * Provenance written by the `apply-video-geo-backfill` migration when it
   * borrows GPS from a temporally-nearby photo. Lives outside `exif` so a
   * future EXIF re-parse cannot silently overwrite it. Set alongside the GPS
   * write; never updated. `null` on assets whose GPS came from EXIF directly.
   */
  geo_inferred?: {
    /** Always "temporal-neighbor" for v1. */
    source: 'temporal-neighbor';
    /** _id of the donor asset whose GPS was borrowed. */
    donor_id: ObjectId;
    /** Absolute time difference in milliseconds between the video and the donor. */
    donor_delta_ms: number;
    /** ISO timestamp when the backfill was applied. */
    at: string;
  } | null;
  /**
   * Sentinel written by `apply-video-geo-backfill` so a non-applicable video
   * cannot head-of-line-block the migration queue indefinitely. `'no-donor'`:
   * no GPS donor within ±15 min in the same library. `'skip'`: defensive —
   * missing `captured_at` or no live `fileinfo` entry. Absent on assets that
   * were successfully backfilled or were never candidates.
   */
  geo_backfill_skipped?: 'no-donor' | 'skip';
  /**
   * Maple stable image id (see `indexer/id.ts`) — NOT a hash of the full
   * original bytes. Derived from a SHA1 of just the first 64 KB
   * (`SHA1_HEAD_BYTES`) of the file, combined via BLAKE3 with EXIF capture
   * metadata (capture timestamp, camera serial, shutter count) when
   * available ("primary" form), or with the file size alone ("fallback"
   * form) when it isn't. Populated on nearly every asset, via three write
   * paths:
   *  - Discover watcher (`workers/discover/handle-event.ts`, `hashFileForId`):
   *    computed inline at insert time for every locally-discovered file, in
   *    fallback form — this is the primary path, not a stopgap (the old
   *    separate `hash` stage was retired in the drop-abs-path-2026-05-21
   *    migration).
   *  - EXIF stage (`workers/stages/exif.ts`): upgrades the id in place to
   *    primary form once `captured_at` is available.
   *  - Backup ingest endpoint (`routes/backup-ingest.ts`): sets it directly
   *    for PhotoKit-originated assets that never go through discover (id
   *    computed client-side).
   * null/absent only for assets that predate one of these paths or hit an
   * error before hashing. Used as the deduplication key when the same
   * content arrives from multiple devices or discovery paths.
   */
  maple_id?: string;
  /** SHA-1 of the first `SHA1_HEAD_BYTES` of file content — the stable join
   * key across the maple_id fallback→primary upgrade (set once at insert by
   * the discover watcher, never rewritten). null/absent on legacy rows that
   * predate content hashing; the discover modified-content guard adopts the
   * computed hash onto such a row on re-discover rather than treating "no
   * recorded hash" as changed content (#2171). Declared here because
   * discover reads/writes it through `assetsCollection()` — it was
   * previously write-only from the schema's point of view. */
  sha1_head?: string | null;
  /**
   * ISO timestamp of the last successful upload of this asset's
   * content-addressed thumbnail to the Cloudflare R2 mirror (see
   * `cloudflare/r2-client.ts`). Absent/null means the thumbnail either
   * hasn't been generated yet, Cloudflare upload is disabled, or the
   * `cf-thumb-sync` pipeline stage (`workers/stages/cf-thumb-sync.ts`)
   * hasn't reached this asset yet — all three are indistinguishable and
   * all three mean "still pending" to that stage's claim query. Never
   * holds a URL: the R2 object key is always re-derived from `(library
   * slug, fileinfo[0].path, fileinfo[0].filename)` via
   * `cloudflare/thumb-key.ts`, mirroring the existing "never persist a
   * derivable thumb path" convention (see `workers/stages/thumb.ts`).
   */
  cf_thumb_synced_at?: string | null;
  /**
   * Per-stage cooldown bookkeeping written by the derivative-audit worker
   * (`workers/derivative-audit/`). Keyed by pipeline stage name; records how
   * many times the auditor has re-armed that stage for this asset and when,
   * so a stage that keeps marking itself done without producing output isn't
   * re-armed forever. Cleared for a stage once its derivative verifies present
   * again. Absent until the auditor first acts on the asset.
   */
  derivative_audit?: Record<string, DerivativeAuditStageMark> | null;
  /**
   * Denormalized count of live `fileinfo` entries (entries where neither
   * `deleted_at` nor `missing_since` is set). Maintained at every liveness
   * mutation site and backfilled by the `backfill-live-location-count`
   * migration. Indexed by `live_location_count_gte2` (partial index,
   * `{ $gte: 2 }`) so `countDocuments({ live_location_count: { $gte: 2 } })`
   * is an index COUNT_SCAN with no per-row FETCH, replacing the `$expr`+`$filter`
   * scan that `liveAwareDuplicatePredicate` required (#1302).
   *
   * Optional because legacy rows pre-date this field; the
   * `backfill-live-location-count` migration populates them. Absent rows are
   * excluded from the partial index and are not counted in the deduplicate
   * badge until the migration runs.
   */
  live_location_count?: number;
  /** True iff an XMP sidecar exists on disk next to this asset. Populated
   * by the XMP write/delete handlers (Phase 5b). Optional because legacy
   * rows pre-date the flag; readers should treat missing as `false`. */
  has_xmp?: boolean;
  /**
   * Monotonic sidecar-edit counter, incremented on every XMP write. A general
   * edit-generation marker consumed by the client editor write-policy work
   * (#2009/#2010); it no longer keys any preview cache file. Under #2017 the
   * preview is a single, unversioned `<filename>.avif` overwritten in place on
   * edit, so there is no per-version preview file to key off this. Absent/`0`
   * means no edit has been recorded.
   */
  sidecar_ver?: number;
  /**
   * Sparse user-edit overlay reconciled from the XMP sidecar by the
   * `sidecar-metadata-index` stage (#1580 — Batch Metadata M1). Absent until first
   * batch edit; `null` when the override has been reset.
   * `effectiveMetadata()` reads this first, then falls back to `exif.*`.
   */
  metadata_override?: MetadataOverride | null;
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
  /**
   * REMOVED — the "pending delete" tag moved to the per-location
   * `FileInfo.missing_since` (the missing-reaper now operates per entry:
   * re-stat → recover or `$pull` → delete the record when no entry remains).
   * The `migrate-missing-since-to-fileinfo` migration in `db/migrations.ts`
   * folds any legacy root value down onto the row's fileinfo entries and
   * `$unset`s this field, so live databases carry it only transiently. Kept
   * on the type (optional) so the migration and any not-yet-migrated row can
   * still be read; nothing writes it anymore.
   */
  missing_since?: string | null;
  /**
   * "Damaged file" tag. Set by a file-reading stage (exif / thumb / preview —
   * those with `tagsDamagedOnDeadLetter`) the moment it EXHAUSTS its retries
   * (`attempts >= maxAttempts`) on an error that means the bytes themselves are
   * unreadable: a corrupt/truncated original, or a format no decoder on the
   * box can parse. The file was retried `maxAttempts` times and still failed,
   * so further attempts are futile.
   *
   * Like `missing_since`, the tag PARKS the asset out of EVERY stage's claim
   * query (see `buildClaimQuery`) so the rest of the pipeline stops burning
   * cycles on a file it can never process. Unlike `missing_since`, there is no
   * automatic reaper: a damaged file still exists on disk, so it's surfaced in
   * the Workers UI (the "Damaged" pill + list) for an operator to inspect,
   * replace, or clear. Re-running `retry-dead` on the tagging stage does NOT
   * clear it — the dedicated clear path (`POST /api/workers/damaged/clear`)
   * does, which both un-tags and re-queues the file.
   *
   * Distinct from `dead` (per-stage, one stage gave up but the file may still
   * be fine for other stages) and from `missing_since` (bytes gone from disk).
   */
  damaged?: DamagedInfo | null;
}

/**
 * Provenance for the {@link AssetDoc.damaged} tag. Captured once, on first
 * detection (first-write-wins, so repeated stage runs can't rewrite `since`).
 */
export interface DamagedInfo {
  /** ISO 8601 timestamp the asset was first tagged damaged. */
  since: string;
  /** Name of the stage that exhausted its retries and tagged the file. */
  stage: string;
  /** The stage's last error message (what made it unreadable), truncated for
   * storage so a giant decoder dump can't bloat the row. */
  reason: string;
}

/** One stage's derivative-audit cooldown mark (see `AssetDoc.derivative_audit`). */
export interface DerivativeAuditStageMark {
  /** Consecutive audit re-arms that did not resolve the drift. */
  attempts: number;
  /** ISO 8601 timestamp of the most recent re-arm. */
  last_reset_at: string;
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
  /** Operator soft-hide marker. Absent/false = visible. A hidden person is
   * filtered out of the normal `/api/people` listing and surfaced only on
   * the Hidden page (`listHiddenPeople`), where it can be restored. The
   * person's faces stay ASSIGNED to it, and the row stays a clustering seed
   * (see `loadCentroids` / `recomputeCentroids`) so newly-detected matching
   * faces keep flowing into the hidden person rather than spawning a fresh
   * visible "Person N". Additive — no migration needed. */
  hidden?: boolean;
  /** Best-matching other live, non-hidden, non-dismissed person by centroid
   * cosine similarity, if it clears MERGE_SUGGESTION_THRESHOLD
   * (`people-merge-suggestions.ts`). Refreshed by the clustering job
   * alongside `centroid`; null when no qualifying match exists. */
  suggested_merge_person_id?: ObjectId | null;
  /** Cosine similarity score backing `suggested_merge_person_id`, for
   * display ("87% match"). Refreshed alongside the id; null when the id
   * is null. */
  suggested_merge_score?: number | null;
  /** Ranked merge candidates, best first, refreshed by the clustering job
   * alongside `centroid`. `suggested_merge_person_id`/`_score` above are
   * the denormalized HEAD of this list (kept so the list-grid badge and
   * the dismiss route stay O(1)); this array is what lets the detail
   * banner advance to the next candidate the instant one is dismissed or
   * merged, instead of going empty until the next clustering run.
   * Absent on rows written before the ranked list landed — readers fall
   * back to the head fields. */
  suggested_merges?: Array<{ person_id: ObjectId; score: number }> | null;
  /**
   * Denormalized count of this person's live assigned faces: faces with
   * `person_id` set to this person's hex id, `hidden !== true`, and a
   * non-merged person doc. Maintained incrementally on every write path
   * that changes face membership (assign, unassign, hide, merge) and
   * recomputed authoritatively each clustering pass. Populated by the
   * `backfill-person-face-count-2026-06-27` migration for existing rows.
   * Absent/undefined on rows that pre-date the migration — readers fall
   * back to 0 until the migration runs.
   */
  face_count?: number;
}

export type PersonWithId = WithId<PersonDoc>;

/**
 * One permanently-dismissed "not a match" pair from the person-page
 * merge-suggestion banner. `pair` is direction-independent — see
 * `sortedPairKey` in `people-merge-suggestions.ts`, which is the single
 * source of the exact string format both the read and write sides use.
 */
export interface PersonMergeDismissalDoc {
  pair: string;
  created_at: string;
}

/**
 * Default empty state for one enrichment stage. The fast pipeline's skeleton
 * upsert seeds every stage with this shape on insert; readers fall back to it
 * when an old row pre-dates the `enrichment` subdocument.
 */
// Internal to this module (the stage-skeleton seeders below); fallow flags it
// as an unused export because nothing outside schema.ts imports it (#1950).
function pendingStageState(): EnrichmentStageState {
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

// ---------------------------------------------------------------------------
// JobRunner — sibling subsystem to the indexer pipeline for user-triggered
// long-running work (export, batch reprocess, …). See
// `docs/workers-architecture.md` §9, §11. Persisted job documents with
// progress reporting, atomic claim-and-lease (mirrors the geocode worker),
// and cooperative cancellation.
// ---------------------------------------------------------------------------

/** Job kinds the runner knows how to dispatch. Add new kinds by extending
 * this union and registering a handler in `job-runner/handlers/index.ts`. */
export type JobKind = 'batch_jpeg_export' | 'pano_stitch';

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
// Imports (ticket #742)
//
// Copy a server-local folder into a registered Library, laid out as
// `<LibRoot>/<YEAR>/<MM-or-label>/<filename>`. The `imports` collection IS
// the work queue — claim/lease fields live on the doc, mirroring `JobDoc`.
// See `docs/plans/2026-05-31-imports-feature.md`.
// ---------------------------------------------------------------------------

/** Lifecycle: pending → running → (done | failed | cancelled). */
export type ImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** How the import worker treats each file:
 *   - `image`   — copied AND handed to the indexer via `handleEvent`.
 *   - `sidecar` — copied alongside its parent image; never indexed directly.
 *   - `movie`   — copied but NOT indexed (the watcher is image-only, v1). */
export type ImportFileKind = 'image' | 'sidecar' | 'movie';

/** Per-file outcome, filled in by the worker as it copies. */
export type ImportFileState = 'pending' | 'copied' | 'skipped_duplicate' | 'failed';

export interface ImportFileEntry {
  /** Absolute source path on the server. */
  src: string;
  /** Destination RELATIVE to the target library root (POSIX-separated). */
  dest: string;
  size: number;
  /** Source mtime epoch-ms — the bucketing basis, retained for audit. */
  mtime: number;
  kind: ImportFileKind;
  state: ImportFileState;
  /** Failure detail when `state === 'failed'`. */
  error: string | null;
}

export interface ImportDoc {
  status: ImportStatus;
  /** Absolute source folder the user picked (jailed to MAPLE_ROOTS). */
  source_root: string;
  /** Target library — a registered FolderDoc: id + path snapshot. */
  library_id: ObjectId;
  library_root: string;
  /**
   * LEGACY ONLY — the per-file entries used to live inline here. They now live
   * one-doc-per-file in the `import_files` collection (see `ImportFileDoc`),
   * because a folder with tens of thousands of files serialized a single
   * `imports` document past MongoDB's hard 16 MiB document ceiling (and the
   * BSON driver's 17 MiB serialization buffer), which threw
   * `RangeError [ERR_OUT_OF_RANGE]` mid-scan and failed the whole import.
   *
   * New imports never set this field; it is read (best-effort) only to keep
   * the detail view of pre-migration imports working. Do not write it.
   */
  files?: ImportFileEntry[];
  /** Auto Import: the worker scans `source_root` and populates the
   * `import_files` collection itself (default `MM` bucket labels) when it
   * claims the job, instead of the files being resolved up-front by the create
   * request. `false` for the manual (reviewed-buckets) path, whose files are
   * pre-resolved. */
  scan_pending: boolean;
  /** Coarse progress; `total` === the number of `import_files` rows (0 until
   * an Auto Import's worker-side scan completes). */
  progress: { current: number; total: number };
  counts: { copied: number; skipped: number; failed: number };
  error: string | null;
  /** Worker id holding the claim; null when available. */
  locked_by: string | null;
  /** Lease expiry (ISO). A crashed worker's claim auto-releases. */
  lease_expires_at: string | null;
  /** Cancellation flag; observed between files. */
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

export type ImportWithId = WithId<ImportDoc>;

/**
 * One file in an import, stored in its OWN `import_files` collection document
 * rather than inline on the `imports` doc. This is the fix for the
 * tens-of-thousands-of-files case: an inline array blew past MongoDB's 16 MiB
 * per-document limit (surfacing as a BSON `ERR_OUT_OF_RANGE` at the 17 MiB
 * serialization-buffer boundary) and failed the import during scanning.
 *
 * `(import_id, idx)` is unique. `idx` is the file's stable 0-based position so
 * the worker can pull files back in deterministic order and target a single
 * row's progress update without rewriting the whole set.
 */
export interface ImportFileDoc extends ImportFileEntry {
  import_id: ObjectId;
  idx: number;
}

// ---------------------------------------------------------------------------
// Discover frontier (resumable directory walk)
// ---------------------------------------------------------------------------

/**
 * One directory still to visit in an in-progress discover sweep. The frontier
 * lives in Mongo (not heap) so the walk's memory is O(one directory), not
 * O(tree). `(folder_id, dir_path, sweep_gen)` is unique so a re-seed can't
 * double-enqueue. `claimed_at` is a lease so a crashed sweeper's dir is retaken.
 */
export interface DiscoverFrontierDoc {
  folder_id: ObjectId;
  dir_path: string; // absolute
  sweep_gen: number;
  claimed_at: number | null; // ms epoch lease; null = free
  enqueued_at: number;
}

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
  /** Rotation lineage (#858). A login starts a family; every rotation stays in
   * it. Reuse detection and logout revoke a family (one device), not the whole
   * user. Optional only for tokens issued before family tracking. */
  family_id?: ObjectId;
  /** Set on every member when logout/reuse deliberately revokes the family. */
  family_revoked_at?: string;
  /** Device-session platform marker (Maple TV epic, milestone B, #2075). Set
   * on a paired-device login (e.g. 'tvos') and propagated across rotation /
   * grace re-mint so the whole family stays labeled. Absent for plain
   * browser/native logins. */
  platform?: string;
}

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

// ---------------------------------------------------------------------------
// Native one-time auth code (#856) — PKCE code-exchange for the Apple shell,
// replacing the legacy token-in-redirect-URL bridge. Short TTL; single-use.
// ---------------------------------------------------------------------------

export interface NativeAuthCodeDoc {
  code_hash: string; // sha256(raw code), hex
  code_challenge: string; // PKCE S256: base64url(sha256(verifier))
  state: string; // opaque CSRF token echoed back to the native app
  user_id: ObjectId;
  device_label: string; // label for the refresh token minted at redeem
  created_at: string;
  expires_at: Date; // TTL — MUST be a Date (TTL monitor ignores ISO strings)
  consumed_at: string | null;
}

// ---------------------------------------------------------------------------
// LAN handoff one-time code — a signed-in web session (on the public URL)
// mints this so the SAME browser can redeem it on the server's LAN address
// without repeating the WebAuthn ceremony (which requires a secure context
// the LAN's plain-HTTP origin can't provide). No PKCE: unlike the native
// flow, there is no separate side-channel to keep a verifier out of the
// redirect URL here (both origins are the same browser tab), so a bare
// single-use, short-TTL code carries the same guarantee a code+verifier
// pair would.
// ---------------------------------------------------------------------------

export interface LanHandoffCodeDoc {
  code_hash: string; // sha256(raw code), hex
  user_id: ObjectId;
  device_label: string;
  created_at: string;
  expires_at: Date; // TTL — MUST be a Date (TTL monitor ignores ISO strings)
  consumed_at: string | null;
}

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
  /** Target path under the library root, decided by the device pre-upload.
   * Stays the device-computed value so a retry that recomputes the same path
   * from its headers still matches and short-circuits — even when the bytes
   * actually landed at a disambiguated sibling (see `resolved_rel_path`). */
  target_rel_path: string;
  /** Where the bytes were ACTUALLY written, when it differs from
   * `target_rel_path` (a path collision was disambiguated to a `-N` sibling).
   * The `alreadyComplete` short-circuit returns this so a retrying device
   * writes its sidecar / rendered companions next to the real file. Unset in
   * the common case where the computed path was free. */
  resolved_rel_path?: string;
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
 * A small key/value collection for server-wide singletons. Rows:
 *   - `_id: "asset_changes_cursor"` — holds the next cursor value to allocate
 *     (numeric, in `seq`).
 *   - `_id: "jwt_secret"` — the HS256 signing key for access tokens (string,
 *     in `value`). Stored here so every instance shares one secret and it
 *     survives container recreates. See `auth/jwt-secret.repo.ts`.
 */
export interface ServerStateDoc {
  _id: string;
  /** For the asset_changes counter row: the most recently allocated
   * cursor. The next allocation atomically `$inc`'s this and returns
   * the new value. */
  seq?: number;
  /** For string-valued singletons (e.g. the `jwt_secret` row). */
  value?: string;
}

// ---------------------------------------------------------------------------
// Metadata override (#1580 — Batch Metadata M1)
// ---------------------------------------------------------------------------

/**
 * Sparse subdoc reconciled from the XMP sidecar by the `sidecar-metadata-index`
 * stage. Holds the search/sort/geo-relevant subset of the user's edits.
 * `asset.exif` stays immutable — this overlay is what `effectiveMetadata()`
 * reads first.
 *
 * GPS stays in `{ lat, lng }` form to match `exif.gps` (not GeoJSON).
 * `touched_fields` records which fields the user actually set, for provenance.
 */
export interface MetadataOverride {
  /** ISO 8601 timestamp of the most recent edit. */
  edited_at: string;
  /** Keys the user has explicitly set (drives reset-to-original). */
  touched_fields: string[];
  /** Overridden GPS coordinates. Nullish (absent/null) → effective falls back to exif.gps. */
  gps?: { lat: number; lng: number; alt?: number } | null;
  /** Overridden ISO 8601 capture time with offset. Nullish → effective falls back to exif. */
  captured_at?: string | null;
  /** IANA time zone name, e.g. "Europe/Paris". */
  time_zone?: string | null;
  /** IPTC place text fields. */
  place_text?: {
    sublocation?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    country_code?: string | null;
  } | null;
  /** IPTC keywords (dc:subject bag). */
  keywords?: string[] | null;
  /** XMP title (dc:title). */
  title?: string | null;
  /** XMP caption / description (dc:description). */
  caption?: string | null;
  /** Photoshop headline. */
  headline?: string | null;
  /** Photoshop instructions. */
  instructions?: string | null;
  /** Creator / author (dc:creator). */
  creator?: string | null;
  /** Creator job title (photoshop:AuthorsPosition). */
  creator_job_title?: string | null;
  /** Copyright notice (dc:rights). */
  copyright_notice?: string | null;
  /** Copyright status tri-state (xmpRights:Marked). */
  copyright_status?: 'unknown' | 'copyrighted' | 'public-domain' | null;
  /** Usage terms (xmpRights:UsageTerms). */
  usage_terms?: string | null;
  /** Credit (photoshop:Credit). */
  credit?: string | null;
  /** Source (photoshop:Source). */
  source?: string | null;
  /** Star rating 1–5 from xmp:Rating (0/absent → not set). */
  rating?: number;
  /** Pick/reject flag string from papp:Flag. */
  flag?: 'pick' | 'reject';
  /** Color label string from papp:ColorLabel. */
  color_label?: string;
  /**
   * Derived effective capture year/month (from `captured_at ?? exif.captured_at`),
   * stored here — NOT under `exif.*`, which stays the immutable file-original.
   * Populated by the sidecar-metadata-index stage; search/sort read the effective value.
   */
  captured_year?: number;
  captured_month?: number;
  /** Custom screenshot flag. null means "clear". */
  is_screenshot?: boolean | null;
  /** Custom hidden flag from papp:Hidden. `sidecar-metadata-index` reads
   * this via `override.hidden ?? (priorHidden || nativeHidden)` (nullish
   * coalescing): only an explicit `true`/`false` is an override — `true`
   * forces hidden, `false` forces un-hidden (taking precedence over any
   * AI-derived or prior hidden state). `null` is NOT a "force visible"
   * signal — it behaves identically to the field being absent, clearing
   * any override and falling back to the prior/AI-derived state. */
  hidden?: boolean | null;
}

// ---------------------------------------------------------------------------
// Presets (#1115, spec §10.7)
// ---------------------------------------------------------------------------

/**
 * A user develop preset — a named, schema-versioned SPARSE `AdjustmentModel`
 * (only non-default fields). `fields` keys are the canonical snake_case
 * names from `raw_core::types::ADJUSTMENT_SCHEMA` (the same stable keys the
 * generated Swift `FieldName` enum exposes), so a document written by any
 * platform parses on every other one.
 *
 * Unknown `fields` keys (from newer schema versions) are stored verbatim and
 * returned verbatim — the XMP passthrough philosophy applied to presets.
 * Unknown TOP-LEVEL keys the client sent ride in `extra` and are spread back
 * onto the wire row on read, so a newer client round-trips its own keys.
 *
 * Built-in presets are NOT stored here — they ship as bundled JSON in each
 * client (`src/apple/.../Resources/builtin-presets.json`) and are read-only.
 */
export interface PresetDoc {
  /** Trimmed display name, 1..120 chars. Unique per database under a
   * case-insensitive collation (index in `ensureIndexes`). */
  name: string;
  /** Preset document schema version (current = 1). Documents with a NEWER
   * version are accepted and preserved so a downlevel server doesn't eat
   * presets written by an uplevel client. */
  schema_version: number;
  /** Sparse adjustment fields, canonical snake_case keys → scalar values. */
  fields: Record<string, number | string | boolean>;
  /** Unknown top-level keys from the create payload, preserved verbatim. */
  extra?: Record<string, unknown>;
  /** ISO timestamp the preset was created. */
  created_at: string;
  /** ISO timestamp of the last write to this row. */
  updated_at: string;
}
