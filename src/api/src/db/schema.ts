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
}

export type AssetWithId = WithId<AssetDoc>;

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
