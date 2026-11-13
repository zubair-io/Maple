// HostedMapleIdService — computes + caches a real `maple_id` for a Hosted-mode
// (File System Access API) local file (#1995, epic #1993).
//
// Orchestrates the pieces built for this ticket:
//   1. Read the bounded 64 KB head (`SHA1_HEAD_BYTES` in `maple-id.ts`).
//   2. Find a capture timestamp the way the server's `readExif` does: a video
//      (`VIDEO_EXTENSIONS`) is dated from its QuickTime `moov` atom
//      (`video-capture-date.ts`, #5079), never from EXIF; a JPEG or TIFF-family
//      file (every RAW) has its two ExifIFD date tags read by the shared tag
//      reader (`exif-capture-dates.ts`, #5090), which the server's `readExif`
//      uses too; any other container goes to `exifr` (same package + same two
//      tags `normalizeExif` consults).
//   3. `captured_at` present  -> primary form, plain TS (`primary()` in
//      `maple-id.ts` — bounded 64 KB, no WASM round-trip needed).
//      `captured_at` absent   -> fallback form, streamed through the WASM
//      `FallbackIdHasher` via `MapleIdFallbackHasherService` (the full file,
//      chunked `File.slice()` reads — never buffered whole in memory).
//   4. Cache the result in IndexedDB (`maple-id-cache.ts`), validated against
//      the file's `size`/`lastModified` on every read so a file replaced at
//      the same path can't inherit a stale id.
//
// Camera serial + shutter count: the server's `primary()` caller
// (`src/api/src/workers/stages/exif.ts`) ALWAYS passes `null` for both —
// `AssetExif` has no schema fields for them yet ("camera_serial not in
// AssetExif schema yet" / "shutter_count not in AssetExif schema yet" per
// that file's comments). This service matches that reality: it never
// extracts or passes camera serial / shutter count. If the server schema
// grows those fields, this service needs a matching update to stay at parity
// — not a decision this ticket should get ahead of.

import { Injectable, inject } from '@angular/core';
import { VIDEO_EXTENSIONS } from '../state/no-preview-extensions';
import { capturedAtFromExif } from './captured-at';
import { blobReader, readRawCaptureDates } from './exif-capture-dates';
import { ExifReaderService } from './exif-reader.service';
import { fromHex, primary, SHA1_HEAD_BYTES, type MapleId } from './maple-id';
import { MapleIdCacheService } from './maple-id-cache';
import { MapleIdFallbackHasherService } from './maple-id-fallback-hasher.service';
import { videoCaptureDate } from './video-capture-date';

/** The only EXIF tags this service needs — mirrors the subset of
 * `src/api/src/indexer/exif.ts`'s `EXIF_PICK_TAGS` that feeds `captured_at`.
 * Picking narrowly (vs. the server's full tag list, which also covers
 * camera/lens/GPS fields irrelevant to `maple_id`) keeps the parse fast and
 * avoids pulling unrelated tag data into memory for every browsed file. */
const CAPTURED_AT_PICK_TAGS = ['DateTimeOriginal', 'CreateDate'] as const;

@Injectable({ providedIn: 'root' })
export class HostedMapleIdService {
  private readonly exifReader = inject(ExifReaderService);
  private readonly fallbackHasher = inject(MapleIdFallbackHasherService);
  private readonly idCache = inject(MapleIdCacheService);

  /**
   * Return the cached `maple_id` hex for `key` if it matches `file`'s current
   * `size`/`lastModified`; otherwise compute (primary or fallback form per
   * EXIF availability), cache the result under `key`, and return it.
   *
   * `key` should be the file's stable address (`formatAddress` — `slug:relPath`)
   * so a later revisit of the same folder can hit the cache without re-reading
   * or re-hashing.
   */
  async getOrComputeMapleId(key: string, file: File): Promise<string> {
    const cached = await this.idCache.get(key, file.size, file.lastModified);
    if (cached !== null) return cached;

    const id = await this.computeMapleId(file);
    await this.idCache.put(key, file.size, file.lastModified, id.hex);
    return id.hex;
  }

  /** Compute a `maple_id` for `file` without consulting or writing the cache. */
  async computeMapleId(file: File): Promise<MapleId> {
    const capturedAt = await this.readCapturedAt(file);
    if (capturedAt !== null) {
      const headBuffer = await file.slice(0, SHA1_HEAD_BYTES).arrayBuffer();
      return primary(new Uint8Array(headBuffer), capturedAt, null, null);
    }
    const hex = await this.fallbackHasher.hashFallback(file);
    return fromHex(hex);
  }

  private async readCapturedAt(file: File): Promise<string | null> {
    try {
      const dot = file.name.lastIndexOf('.');
      if (dot > 0 && VIDEO_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase())) {
        return await videoCaptureDate(file);
      }
      const dates = await readRawCaptureDates(blobReader(file));
      if (dates) return capturedAtFromExif({ ...dates });
      const raw = await this.exifReader.parse(file, CAPTURED_AT_PICK_TAGS);
      return raw ? capturedAtFromExif(raw) : null;
    } catch {
      // Unparseable / unsupported format / corrupt header — same "no usable
      // EXIF" outcome the server's `readExif` reaches for its NO_EXIF_EXTS
      // set and for parse failures it doesn't want to propagate here (unlike
      // the server's stage runner, there is no retry/backoff to gain from
      // surfacing this — a browsing folder listing must not hang or error on
      // one unreadable file's metadata).
      return null;
    }
  }
}
