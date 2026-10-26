import { open, stat } from '../../fs/mirrored.ts';
import { fileByteSource, SourceChangedError, type ByteSource } from './byte-source.ts';
import { detectContainer } from './container.ts';
import { readHeifXmp } from './heif-xmp.ts';
import { startsWithFtyp } from './iso-bmff.ts';
import { readJpegXmp } from './jpeg-xmp.ts';
import { detectMicroVideo } from './micro-video.ts';
import { detectSamsungSef } from './samsung-sef.ts';
import { still, type MotionClip, type MotionDetection, type StillKind } from './types.ts';
import { parseMotionXmp } from './xmp-fields.ts';

export type { MotionClip, MotionDetection, MotionVideoMime } from './types.ts';

/** A detection against one file, carrying the size the verified range belongs to. */
export type FileMotionDetection = { motion: MotionClip; sourceSize: number } | { still: string };

async function stillKind(source: ByteSource): Promise<StillKind | null> {
  const head = await source.read(0, 8);
  if (!head) return null;
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpeg';
  return head.toString('latin1', 4, 8) === 'ftyp' ? 'heif' : null;
}

/**
 * Precedence: Motion Photo 1.0 when `GCamera:MotionPhoto` is declared at all,
 * then a Samsung SEF `MotionPhoto_Data` record, then legacy Pixel
 * `MicroVideoOffset`. Every path ends in an `ftyp` check at the computed offset.
 */
export async function detectInSource(source: ByteSource): Promise<MotionDetection> {
  const kind = await stillKind(source);
  if (!kind) return still('not a JPEG or HEIF still');
  const packet = kind === 'jpeg' ? await readJpegXmp(source) : await readHeifXmp(source);
  const xmp = packet === null ? null : parseMotionXmp(packet);
  if (xmp?.camera.has('MotionPhoto')) return detectContainer(source, kind, xmp);
  const samsung = kind === 'jpeg' ? await detectSamsungSef(source) : null;
  return samsung ?? detectMicroVideo(source, kind, xmp);
}

/**
 * Detect the clip embedded in a still, reading metadata only: segment and box
 * headers, the XMP packet, the SEF directory and the first bytes at the clip's
 * offset — never pixels, and at most 8 MB in total. A file whose size, mtime
 * or identity changed while it was read throws {@link SourceChangedError} so
 * the caller retries once the write settles, instead of recording a range that
 * a half-copied file happened to satisfy.
 */
export async function detectMotionPhoto(
  absPath: string,
  signal: AbortSignal,
): Promise<FileMotionDetection> {
  const handle = await open(absPath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) return still('not a regular file');
    const detection = await detectInSource(fileByteSource(handle, absPath, before.size, signal));
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), stat(absPath)]);
    const unchanged = [afterHandle, afterPath].every(
      (after) =>
        after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino,
    );
    if (!unchanged) throw new SourceChangedError(absPath);
    return 'motion' in detection ? { ...detection, sourceSize: before.size } : detection;
  } finally {
    await handle.close();
  }
}

/**
 * Whether the range recorded for a clip still holds one: the original has the
 * size it had when the range was verified and an ISO-BMFF `ftyp` still opens
 * the range. Lets the clip route refuse an edited original before the stage
 * has re-run over it, instead of streaming whatever bytes now sit there.
 */
export async function clipStillInPlace(
  absPath: string,
  clip: Pick<MotionClip, 'start' | 'length'>,
  sourceSize: number,
): Promise<boolean> {
  const handle = await open(absPath, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size !== sourceSize) return false;
    const source = fileByteSource(handle, absPath, current.size, new AbortController().signal);
    return await startsWithFtyp(source, clip.start, clip.length).catch(() => false);
  } finally {
    await handle.close();
  }
}
