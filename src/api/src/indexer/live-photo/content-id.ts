import { withStableSource, type ByteSource } from '../motion-photo/byte-source.ts';
import { readHeifItem } from '../motion-photo/heif-items.ts';
import { readJpegExif } from '../motion-photo/jpeg-app1.ts';
import { appleContentIdentifier } from './apple-makernote.ts';
import type { LiveFileKind } from './live-file-kind.ts';
import { readQuickTimeContentIdentifier } from './quicktime-content-id.ts';

const IDENTIFIER_PATTERN = /^[\x21-\x7e]{8,64}$/;

/** A HEIF Exif item opens with the byte count between that field and the TIFF header. */
function heifExifTiff(item: Buffer): Buffer | null {
  if (item.length < 4) return null;
  const tiffStart = 4 + item.readUInt32BE(0);
  return tiffStart < item.length ? item.subarray(tiffStart) : null;
}

async function stillTiff(source: ByteSource): Promise<Buffer | null> {
  const head = await source.read(0, 8);
  if (!head) return null;
  if (head[0] === 0xff && head[1] === 0xd8) return readJpegExif(source);
  if (head.toString('latin1', 4, 8) !== 'ftyp') return null;
  const item = await readHeifItem(source, 'exif');
  return item && heifExifTiff(item);
}

async function rawIdentifier(source: ByteSource, kind: LiveFileKind): Promise<string | null> {
  if (kind === 'clip') return readQuickTimeContentIdentifier(source);
  const tiff = await stillTiff(source);
  return tiff && appleContentIdentifier(tiff);
}

/**
 * Apple's Live Photo content identifier of a still or clip, upper-cased, or
 * null when the file carries none (a photo from another camera, an edited
 * export, a clip that is just a video). Reads metadata only — headers, the Exif
 * block or the QuickTime key table, at most 8 MB. A file that changed while it
 * was read throws `SourceChangedError` so the caller retries after the write.
 */
export function readLiveContentId(
  absPath: string,
  kind: LiveFileKind,
  signal: AbortSignal,
): Promise<string | null> {
  return withStableSource<string | null>(absPath, signal, null, async (source) => {
    const raw = (await rawIdentifier(source, kind))?.trim();
    return raw && IDENTIFIER_PATTERN.test(raw) ? raw.toUpperCase() : null;
  });
}
