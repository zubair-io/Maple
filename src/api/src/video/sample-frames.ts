/**
 * Frame-sampling orchestrator for the `video-describe` stage (#2158):
 * probe → select → extract, bounded and timed, in one call.
 *
 * Kept separate from the stage handler so it is independently testable
 * with a real ffmpeg and independently swappable in the handler's own
 * tests (fake `sampleVideoFrames` — no ffmpeg needed there at all).
 */

import { child as childLogger } from '../log.ts';
import { extractFramesJpeg } from './frame-extract.ts';
import { selectFrameTimestamps } from './frame-select.ts';
import { probeVideo } from './probe.ts';
import { MAX_FRAME_COUNT, MAX_TOTAL_ENCODED_BYTES } from './constants.ts';

const log = childLogger('video:sample-frames');

export type VideoSampleFailureReason = 'no-video-decoder' | 'no-decodable-frame';

export interface SampledFrame {
  timestampSec: number;
  jpeg: Buffer;
}

export interface SampledVideoFrames {
  ok: true;
  frames: SampledFrame[];
  /** Codec I-frame candidates the probe inspected, before dedup — a
   * `video_description_meta.candidate_count` diagnostic. */
  candidateCount: number;
  /** Wall-clock ms spent probing, selecting, and extracting. */
  samplingMs: number;
}

export interface SampledVideoFailure {
  ok: false;
  reason: VideoSampleFailureReason;
}

/** Drop trailing frames (chronologically last, i.e. least likely to be the
 * clip's defining moment relative to its opening) until the total encoded
 * size clears `MAX_TOTAL_ENCODED_BYTES`. In practice this almost never
 * fires — `MAX_FRAME_COUNT` frames at the model's bounded dimension/quality
 * land well under the ceiling — it exists as a backstop against a
 * pathological input (e.g. an unusually detailed/noisy frame that JPEGs
 * far larger than typical). Always keeps at least one frame. */
function enforceByteBudget(frames: readonly SampledFrame[]): SampledFrame[] {
  let total = frames.reduce((sum, f) => sum + f.jpeg.byteLength, 0);
  const kept = [...frames];
  while (kept.length > 1 && total > MAX_TOTAL_ENCODED_BYTES) {
    const dropped = kept.pop()!;
    total -= dropped.jpeg.byteLength;
  }
  return kept;
}

/**
 * Sample a bounded, deterministic set of frames from `videoPath`, ready to
 * send to the vision provider in one multi-image request.
 *
 * Returns `{ ok: false, reason }` — never throws — for every condition the
 * design doc calls a terminal skip: no runnable ffmpeg, no video stream, a
 * probe timeout, or a clip with no frame that could be decoded at all. The
 * stage handler maps this straight to `StageResult.skip`.
 */
export async function sampleVideoFrames(
  videoPath: string,
): Promise<SampledVideoFrames | SampledVideoFailure> {
  const startedAt = Date.now();
  const probe = await probeVideo(videoPath);
  if (!probe) {
    return { ok: false, reason: 'no-video-decoder' };
  }

  const timestamps = selectFrameTimestamps(probe.candidates, probe.durationSec).slice(
    0,
    MAX_FRAME_COUNT,
  );
  if (timestamps.length === 0) {
    return { ok: false, reason: 'no-decodable-frame' };
  }

  const extracted = await extractFramesJpeg(videoPath, timestamps);
  if (extracted.length === 0) {
    return { ok: false, reason: 'no-decodable-frame' };
  }

  const frames = enforceByteBudget(extracted);
  const samplingMs = Date.now() - startedAt;
  log.debug(
    {
      videoPath,
      candidateCount: probe.candidates.length,
      selected: timestamps.length,
      extracted: extracted.length,
      kept: frames.length,
      samplingMs,
    },
    'sampled video frames',
  );
  return {
    ok: true,
    frames,
    candidateCount: probe.candidates.length,
    samplingMs,
  };
}
