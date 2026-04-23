/**
 * MongoDB schema types for Maple Self Hosted.
 *
 * Collections:
 *   - folders   : registered library roots
 *   - assets    : per-file metadata index (non-authoritative; sidecars are truth)
 *   - indexer_queue : pending background tasks
 *   - users     : Phase 5 auth (scaffolded only)
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
  /** SHA-256 hash of the thumbnail bytes, or null if not yet generated. */
  thumb_hash: string | null;
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
// User (Phase 5 — scaffolded)
// ---------------------------------------------------------------------------

export interface UserDoc {
  email: string;
  /** WebAuthn credential IDs (base64url). */
  credential_ids: string[];
  created_at: string;
}

export type UserWithId = WithId<UserDoc>;
