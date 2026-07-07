/**
 * Wire-shape for `/api/search` result rows and the projection from
 * `AssetDoc` → `SearchResult`. Kept separate from the route handlers
 * so other callers (and tests) can reuse the projection without
 * importing the full Elysia app.
 */

import type { ObjectId } from 'mongodb';
import type { AssetDoc, Place } from '../../db/schema.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';

export interface SearchResultPHLink {
  phasset_local_id: string;
  /** Cross-device join key — present when the device that uploaded had
   * iCloud Photos enabled. See `PhotoKitAssetLink.phasset_cloud_id`. */
  phasset_cloud_id?: string;
}

export interface SearchResult {
  id: string;
  /** `slug:relPath` address for the metadata-snapshot/batch-apply endpoints
   * (`/api/metadata/snapshots`, `/api/xmp/batch`), which only understand the
   * unified addressing scheme — the legacy `id` field above predates that
   * migration and is not a valid input to those endpoints. `null` when the
   * asset's primary library has no registered slug. */
  address: string | null;
  _id: string;
  folder_id: string;
  abs_path: string;
  filename: string;
  size: number;
  mtime: number;
  captured_at: string | null;
  camera: { make: string | null; model: string | null } | null;
  lens: string | null;
  iso: number | null;
  aperture: number | null;
  shutter: string | null;
  focal_length: number | null;
  rating: number;
  flag: -1 | 0 | 1;
  color_label: string;
  /** Reverse-geocoded place; `null` for assets without GPS or before the
   * Phase 2 geocode worker has run. */
  place: Place | null;
  /** LLM-generated caption; `null` before the Phase 6 describe worker has run. */
  description: string | null;
  /** Per-device PhotoKit links written by the backup ingest endpoint.
   * Drives the merged Photos+Cloud timeline's `.synced` badge on the
   * Apple client (see `MergedTimelineSource` in MapleCore). Absent when
   * the asset wasn't ingested via PhotoKit backup. */
  phasset_links?: SearchResultPHLink[];
  /** True iff the XMP write/delete handlers (Phase 5b) have observed
   * a sidecar next to this asset. Drives the S2 Library Grid "Edited"
   * filter chip (#628). Optional because legacy docs predate the flag;
   * readers coerce missing as `false`. */
  has_xmp?: boolean;
  hidden?: boolean;
}

export function projectAsset(
  d: AssetDoc & { _id: ObjectId },
  libraries: ReadonlyMap<string, string>,
  idToSlug: ReadonlyMap<string, string>,
): SearchResult {
  const exif = d.exif ?? null;
  const camera =
    exif && (exif.camera_make !== null || exif.camera_model !== null)
      ? { make: exif.camera_make, model: exif.camera_model }
      : null;
  const primary = assetPrimaryFileInfo(d);
  const absPath = assetAbsPath(d, libraries) ?? '';
  const folderId = primary?.library_id.toHexString() ?? '';
  const filename = primary?.filename ?? '';
  const slug = primary ? (idToSlug.get(primary.library_id.toHexString()) ?? null) : null;
  const address =
    slug && primary
      ? `${slug}:${primary.path ? `${primary.path}/${primary.filename}` : primary.filename}`
      : null;
  const result: SearchResult = {
    // The editor's id format is `fs:<absPath>` (matches Hosted's
    // browser-FS-Access keys); keeping the same shape here lets the FE
    // route a search hit straight into the editor.
    id: `fs:${absPath}`,
    address,
    _id: d._id.toHexString(),
    folder_id: folderId,
    abs_path: absPath,
    filename,
    size: d.size,
    mtime: d.mtime,
    captured_at: exif?.captured_at ?? null,
    camera,
    lens: exif?.lens ?? null,
    iso: exif?.iso ?? null,
    aperture: exif?.aperture ?? null,
    shutter: exif?.shutter ?? null,
    focal_length: exif?.focal_length ?? null,
    rating: d.rating,
    flag: d.flag,
    color_label: d.color_label,
    // Enrichment outputs — null on old rows or before the worker has run.
    // `faces` and the `enrichment` worker-state subdocument are deliberately
    // not on the list payload (face embeddings can be large; worker state is
    // internal). Use `/api/assets/:id` for the full record.
    place: d.place ?? null,
    description: d.description ?? null,
    // S2 "Edited" filter chip backing (#628) — coerce missing to false.
    has_xmp: d.has_xmp ?? false,
    hidden: d.hidden,
  };
  if (d.phasset_links && d.phasset_links.length > 0) {
    // Strip `device_id` and `first_seen` from the wire shape — the merged
    // timeline only needs the two identifiers to do its join.
    result.phasset_links = d.phasset_links.map((l) => {
      const out: SearchResultPHLink = { phasset_local_id: l.phasset_local_id };
      if (l.phasset_cloud_id) out.phasset_cloud_id = l.phasset_cloud_id;
      return out;
    });
  }
  return result;
}
