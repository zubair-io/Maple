/**
 * Full-resolution frame extraction for the `video-describe` stage (#2158).
 *
 * `probe.ts` only ever produces tiny 64×64 thumbnails, for cheap difference
 * comparison — never bytes fit to hand a vision model. Once
 * `frame-select.ts` has settled on the timestamps worth sending, this
 * module seeks to each one, decodes ONE near-lossless frame with ffmpeg
 * (same seek-then-fallback shape as `extractVideoPosterJpeg`), and
 * re-encodes it through `sharp` to the model's bounds — mirroring how
 * `workers/stages/describe.ts` turns the AVIF preview into JPEG bytes
 * immediately before the provider call, no second persisted artefact.
 */

import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { child as childLogger } from '../log.ts';
import { ffmpegBinary } from '../thumbs/video-poster.ts';
import {
  FRAME_EXTRACT_TIMEOUT_MS,
  MODEL_FRAME_JPEG_QUALITY,
  MODEL_FRAME_MAX_DIMENSION,
} from './constants.ts';

const log = childLogger('video:frame-extract');

/** Seek + decode one frame at `timestampSec` to a caller-owned temp path.
 * Near-lossless intermediate (`sharp` does the final resize/quality pass) —
 * mirrors `video-poster.ts`'s `runFfmpeg`, minus its from-frame-0 retry:
 * every timestamp here already came from a real probed position, so a
 * failed seek is a genuine extraction failure, not an expected sub-second
 * edge case. */
async function extractRawFrame(
  bin: string,
  videoPath: string,
  timestampSec: number,
  outPath: string,
): Promise<boolean> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(Math.max(0, timestampSec)),
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-f',
    'image2',
    '-y',
    outPath,
  ];

  let timedOut = false;
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: 'ignore', stderr: 'pipe' });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, FRAME_EXTRACT_TIMEOUT_MS);
    let stderr: string;
    try {
      stderr = await new Response(proc.stderr).text();
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      log.warn({ videoPath, timestampSec }, 'frame extraction timed out');
      return false;
    }
    const stat = await fs.stat(outPath).catch(() => null);
    if (stat && stat.size > 0) return true;
    log.warn({ videoPath, timestampSec, stderr: stderr.trim().slice(0, 300) }, 'no frame decoded');
    return false;
  } catch (e) {
    log.warn({ videoPath, timestampSec, err: e instanceof Error ? e.message : e }, 'extract threw');
    return false;
  }
}

export interface ExtractedFrame {
  timestampSec: number;
  jpeg: Buffer;
}

/**
 * Extract and encode the frames at `timestampsSec` (already ordered
 * chronologically) as model-ready JPEGs.
 *
 * A single timestamp's extraction failure drops that frame from the
 * result rather than failing the whole call — the sampler over-selects
 * from real probed positions, so losing one of several is not fatal. Each
 * returned entry carries its own `timestampSec` (rather than relying on
 * positional alignment with the input) precisely because the result can be
 * shorter than the input; the caller maps the model's `frame_index` back to
 * a real timestamp from these entries, never from `timestampsSec`
 * directly. An empty result (ffmpeg unavailable, or every seek failed) is
 * the caller's cue for a terminal sampling failure.
 */
export async function extractFramesJpeg(
  videoPath: string,
  timestampsSec: readonly number[],
): Promise<ExtractedFrame[]> {
  if (timestampsSec.length === 0) return [];
  const bin = await ffmpegBinary();
  if (!bin) return [];

  const frames: ExtractedFrame[] = [];
  for (const timestampSec of timestampsSec) {
    const tmpPath = join(
      tmpdir(),
      `maple-frame-${process.pid}-${randomBytes(6).toString('hex')}.jpg`,
    );
    try {
      if (!(await extractRawFrame(bin, videoPath, timestampSec, tmpPath))) continue;
      const raw = await fs.readFile(tmpPath);
      const jpeg = await sharp(raw)
        .resize(MODEL_FRAME_MAX_DIMENSION, MODEL_FRAME_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: MODEL_FRAME_JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      frames.push({ timestampSec, jpeg });
    } catch (e) {
      log.warn(
        { videoPath, timestampSec, err: e instanceof Error ? e.message : e },
        'frame re-encode failed',
      );
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
  return frames;
}
