/**
 * MongoDB schema types for Maple Self Hosted.
 *
 * Collections:
 *   - folders   : registered library roots
 *   - assets    : per-file metadata index (non-authoritative; sidecars are truth)
 *   - indexer_queue : pending background tasks
 *   - users, credentials, invites, refresh_tokens, challenges : auth (Phase A)
 */

import type { ObjectId, WithId } from "mongodb";

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

export interface AssetDoc {
  folder_id: ObjectId;
  /** Filename only (no directory). */
  filename: string;
  /** Absolute filesystem path (folder.path + "/" + filename). */
  abs_path: string;
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
  /** LLM-generated caption (Phase 6 describe worker output). `null` until run. */
  description?: string | null;
  /** Recognised text extracted from the thumbnail by the OCR worker.
   * `null` until the worker has run; empty string when nothing was found
   * OR when the mean engine confidence was below the persistence threshold
   * (see `MAPLE_OCR_MIN_CONFIDENCE` in the OCR stage). */
  ocr_text?: string | null;
  /** Per-word OCR output. Persisted regardless of the confidence threshold
   * so the threshold can be re-tuned without re-running the engine. `null`
   * until the worker has run; `[]` when nothing was detected. */
  ocr_words?: OcrWord[] | null;
  /** Provenance of the OCR run. `engine_version` is stamped for human
   * traceability only — reruns are gated by the stage's numeric
   * `targetVersion` (see `workers/stages/ocr.ts`), not by this string. */
  ocr_meta?: {
    engine: "tesseract";
    engine_version: string;
    generated_at: string;
    /** Overall mean confidence as reported by the engine, 0–100. `null`
     * for legacy rows written before per-word capture landed. */
    mean_confidence: number | null;
  } | null;
  /** Synthesised text-index target. Concatenation of `place.search_blob`,
   * `description`, and `ocr_text` — recomputed atomically inside each
   * worker's `complete()` so the value stays consistent without a
   * separate write. The Mongo `$text` index lives on this field
   * (Mongo allows only ONE text index per collection). */
  search_blob?: string;
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
  impl: "builtin" | "http";
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
  /** OCR worker bookkeeping (Phase 8). Pending on every fresh skeleton
   * row; flipped to done by `OcrWorker.complete()`. */
  ocr: EnrichmentStageState;
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
  source: "nominatim";
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
 * and documented at the use site — face detector emits normalised
 * `[0,1]` proportions, the OCR engine emits pixels relative to the
 * input thumbnail. Both share this shape because the arithmetic is
 * identical; consumers must respect the documented units. */
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
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// OCR word — written by the Phase 6 OCR worker alongside `ocr_text`. Lets
// the search layer (and any future filtering) re-score on confidence
// without re-running the engine. Bounding boxes are in pixel coordinates
// relative to the thumbnail the engine was given.
// ---------------------------------------------------------------------------

export interface OcrWord {
  text: string;
  /** Engine-reported confidence, 0–100. */
  confidence: number;
  /** Pixel coordinates relative to the OCR'd thumbnail. Distinct from
   * `AssetFaceDoc.bbox`, which is normalised proportions. */
  bbox: Bbox;
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
    ocr: pendingStageState(),
  };
}

/**
 * Read-side normaliser: returns an `Enrichment` object even when the stored
 * doc has a missing/partial `enrichment` field. Per-stage fields default to
 * the same pending shape that the writer uses on insert, so old rows look
 * indistinguishable from freshly-skeletoned ones.
 */
export function normaliseEnrichment(
  raw: Partial<Enrichment> | undefined | null,
): Enrichment {
  return {
    geocode: { ...pendingStageState(), ...(raw?.geocode ?? {}) },
    face: { ...pendingStageState(), ...(raw?.face ?? {}) },
    describe: { ...pendingStageState(), ...(raw?.describe ?? {}) },
    ocr: { ...pendingStageState(), ...(raw?.ocr ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Indexer queue task
// ---------------------------------------------------------------------------

export type TaskKind = "scan_folder" | "gen_thumb" | "extract_exif";

export interface IndexerTaskDoc {
  kind: TaskKind;
  /** Payload varies by task kind. */
  payload: Record<string, unknown>;
  /** Lifecycle: pending → processing → done | failed. */
  status: "pending" | "processing" | "done" | "failed";
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
export type JobKind = "batch_jpeg_export";

/** Lifecycle: queued → running → (done | failed | cancelled).
 * `cancelled` is set when a running job observes `cancel_requested` between
 * progress steps and exits cleanly. */
export type JobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

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

export type UserRole = "owner" | "member";

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

export type ChallengePurpose = "register" | "authenticate" | "add_credential";

export interface ChallengeDoc {
  challenge: string; // base64url
  purpose: ChallengePurpose;
  user_id: ObjectId | null;
  email: string | null;
  invite_code: string | null;
  expires_at: Date; // TTL — MUST be a Date (TTL monitor ignores ISO strings)
}
export type ChallengeWithId = WithId<ChallengeDoc>;
