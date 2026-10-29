/**
 * Failures that describe the original's bytes rather than the server (#5513).
 * Every other derivative failure defers without spending an attempt (#5478),
 * so a signature belongs here only when no full disk, missing library, lost
 * mount or crashed child can produce its text.
 */
import { stat } from '../fs/mirrored.ts';

/** The decoder refused the source bytes themselves. A property of the asset,
 * like `AuthoredSidecarRenderError`; a crashed child or a full disk is not. */
export class SourceDecodeError extends Error {
  override readonly name = 'SourceDecodeError';
  constructor(srcPath: string, reason: string) {
    super(`Cannot decode ${srcPath}: ${reason}`);
  }
}

/** The container opened but holds no video stream (an audio-only MXF), so it
 * has no poster frame to render. Final, and not damage. */
export class NoVideoStreamError extends Error {
  override readonly name = 'NoVideoStreamError';
  constructor(videoPath: string) {
    super(`${videoPath} has no video stream`);
  }
}

type PermanentSourceFailure = 'undecodable' | 'truncated' | 'no-video-stream';

/** A truncated read is also what a file still being copied in, or a cloud
 * placeholder not yet downloaded, looks like. `damaged` is undone only by an
 * operator, so truncation counts only once the file has stopped changing. */
const SETTLED_AFTER_MS = 60 * 60_000;

/** raw-core's decode-stage `Error::Decode` reasons: later stages (resize,
 * encode) reuse that variant for internal faults, so the reason is matched
 * too rather than the variant's prefix alone. */
const RAW_CORE_FORMAT_REJECTION =
  /rawler failed to decode [^:]*: (cannot identify raster image format|bitmap dimensions )/;
const RAW_CORE_TRUNCATION =
  /rawler failed to decode [^:]*: (jpeg |failed to decode raster pixels|JPEG-compressed TIFF decode failed)/;

const SIGNATURES: ReadonlyArray<readonly [RegExp, PermanentSourceFailure]> = [
  [RAW_CORE_FORMAT_REJECTION, 'undecodable'],
  [RAW_CORE_TRUNCATION, 'truncated'],
  // heic-decode's magic-byte check on bytes already read into memory.
  [/input buffer is not a HEIC image/, 'undecodable'],
  // ag-psd's header and resource-block signature checks.
  [/Invalid signature: '[^']*' at 0x[0-9a-f]+/, 'undecodable'],
  // ffmpeg's mov/mp4 demuxer: the index QuickTime writes last is missing.
  [/moov atom not found/, 'truncated'],
  // ffmpeg opened the input, then found no stream for `-map 0:v:0`.
  [/Stream map '[^']*' matches no streams/, 'no-video-stream'],
];

export function permanentSourceFailure(message: string): PermanentSourceFailure | null {
  return SIGNATURES.find(([signature]) => signature.test(message))?.[1] ?? null;
}

async function settled(srcPath: string): Promise<boolean> {
  const stats = await stat(srcPath).catch(() => null);
  return stats !== null && Date.now() - stats.mtimeMs >= SETTLED_AFTER_MS;
}

/** Throw the typed error for a permanent source failure; resolve otherwise,
 * including for a truncated file modified within the last hour. */
export async function throwIfPermanentSourceFailure(
  message: string,
  srcPath: string,
): Promise<void> {
  const failure = permanentSourceFailure(message);
  if (failure === 'no-video-stream') throw new NoVideoStreamError(srcPath);
  if (failure === 'undecodable' || (failure === 'truncated' && (await settled(srcPath)))) {
    throw new SourceDecodeError(srcPath, message);
  }
}
