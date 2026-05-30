/**
 * WebP EXIF extraction.
 *
 * Why this module exists
 * ----------------------
 * exifr 7.1.3 has no WebP file parser at all — it only recognises JPEG, TIFF
 * (+ TIFF-based RAW), HEIC/HEIF/AVIF, and PNG. Hand it a `.webp` and its
 * reader bails with "Unknown file format" before any tag extraction, so every
 * WebP lands in the index with no capture date, camera, lens, or GPS even
 * though many WebPs (e.g. iPhone exports, converted RAWs) carry a full EXIF
 * block.
 *
 * The fix mirrors `heic-exif.ts`: WebP is a RIFF container, and the EXIF block
 * lives verbatim in an `EXIF` chunk as a bare TIFF. We walk the RIFF chunks
 * ourselves, slice out the TIFF, and hand THAT to `exifr.parse()`, which parses
 * a bare TIFF buffer with no container gating — so all of the existing pick-tag
 * and GPS-sign handling in `readExif` keeps working unchanged.
 *
 * Container reference: WebP Container Specification (RIFF: a 12-byte
 * `RIFF<size>WEBP` header followed by FourCC + little-endian size chunks, each
 * padded to an even byte count). The `EXIF` chunk payload is a TIFF stream,
 * optionally prefixed by the 6-byte `Exif\0\0` marker that some encoders write
 * (the same marker JPEG APP1 uses); we skip it when present so the slice starts
 * on the "II"/"MM" byte-order mark.
 */

import * as fs from 'node:fs/promises';

/**
 * Thrown when a RIFF chunk claims bytes past the end of the file we read —
 * almost always a still-copying (truncated) file, which is transient.
 * `readExif` rethrows it so the stage runner retries once the copy settles,
 * rather than permanently stamping `exif: null`.
 */
export class WebpTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebpTruncatedError';
  }
}

/** The 6-byte `Exif\0\0` marker some encoders prepend to the TIFF stream. */
const EXIF_MARKER = Buffer.from('Exif\0\0', 'latin1');

/** Assert that byte range [off, off+len) lies inside the buffer. */
function need(buf: Buffer, off: number, len: number, what: string): void {
  if (off < 0 || off + len > buf.length) {
    throw new WebpTruncatedError(`${what}: need ${len} bytes at ${off}, file is ${buf.length}`);
  }
}

/**
 * Locate the embedded TIFF block inside a WebP buffer.
 *
 * Returns the TIFF slice (starting at the "MM"/"II" byte-order marker) ready to
 * hand to `exifr.parse`, or null when the container has no `EXIF` chunk. Throws
 * {@link WebpTruncatedError} when the file appears truncated.
 */
export function extractWebpExifTiff(buf: Buffer): Buffer | null {
  // A real WebP opens with `RIFF....WEBP`. Bail to null (rather than throwing
  // on a wild chunk size) when the bytes clearly aren't a RIFF/WebP container,
  // so a mislabelled `.webp` is treated as "no EXIF" instead of an
  // endlessly-retried truncation.
  if (
    buf.length < 12 ||
    buf.toString('latin1', 0, 4) !== 'RIFF' ||
    buf.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return null;
  }

  // Chunks begin right after the 12-byte RIFF/WEBP header. Each chunk is a
  // 4-byte FourCC + 4-byte little-endian payload size, then the payload, padded
  // to an even length.
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    need(buf, payloadStart, size, `chunk '${fourcc}'`);

    if (fourcc === 'EXIF') {
      let tiffStart = payloadStart;
      let tiffLength = size;
      // Strip the optional `Exif\0\0` marker so the slice starts on the TIFF
      // byte-order mark, matching what exifr expects from a bare TIFF.
      if (
        size >= EXIF_MARKER.length &&
        buf.subarray(payloadStart, payloadStart + EXIF_MARKER.length).equals(EXIF_MARKER)
      ) {
        tiffStart += EXIF_MARKER.length;
        tiffLength -= EXIF_MARKER.length;
      }
      if (tiffLength <= 0) return null;
      return buf.subarray(tiffStart, tiffStart + tiffLength);
    }

    // Advance to the next chunk; payloads are padded to an even byte count.
    offset = payloadStart + size + (size & 1);
  }
  return null;
}

/**
 * Read `absPath` and return its embedded EXIF as a bare TIFF buffer, or null
 * when there is no `EXIF` chunk. Throws on I/O errors and on truncation (both
 * transient — the caller retries).
 */
export async function readWebpExifTiff(absPath: string): Promise<Buffer | null> {
  const buf = await fs.readFile(absPath);
  return extractWebpExifTiff(buf);
}
