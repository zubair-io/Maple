/**
 * Duration + candidate-keyframe probe for the `video-describe` stage
 * (#2158).
 *
 * One ffmpeg invocation does three things at once:
 *
 *   1. `-skip_frame nokey` — only decode codec I-frames, the free first-pass
 *      down-select the design doc calls for (candidates are "worth keeping"
 *      because the encoder already chose them as full frames).
 *   2. `-vf showinfo,scale=64:64` — the `showinfo` filter logs each frame's
 *      presentation timestamp to stderr; `scale` produces a small RGB
 *      thumbnail purely for the caller's difference comparison
 *      (`frame-select.ts`) — never sent to the vision model.
 *   3. The plain `Duration: …` line ffmpeg always prints for a readable
 *      container, parsed from the same stderr.
 *
 * Bounded to `MAX_CANDIDATE_FRAMES` via `-frames:v`, and to
 * `PROBE_TIMEOUT_MS` wall-clock — a malformed container can otherwise hang
 * ffmpeg hunting for decodable frames indefinitely, which would hold a
 * stage concurrency slot forever.
 *
 * Reuses `ffmpegBinary()` (`thumbs/video-poster.ts`) for binary discovery —
 * one probed-and-cached ffmpeg path for the whole process, same convention
 * every other video-touching module in this codebase follows.
 */

import { child as childLogger } from '../log.ts';
import { ffmpegBinary } from '../thumbs/video-poster.ts';
import {
  DIFF_THUMB_BYTES,
  DIFF_THUMB_SIDE,
  MAX_CANDIDATE_FRAMES,
  PROBE_TIMEOUT_MS,
} from './constants.ts';

const log = childLogger('video:probe');

export interface FrameCandidate {
  timestampSec: number;
  /** `DIFF_THUMB_SIDE × DIFF_THUMB_SIDE` RGB24 raw pixels, row-major. */
  diffThumb: Buffer;
}

export interface VideoProbeResult {
  durationSec: number;
  /** Ordered, ascending, capped at `MAX_CANDIDATE_FRAMES`. */
  candidates: FrameCandidate[];
}

const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/;
const SHOWINFO_PTS_RE = /Parsed_showinfo[^\n]*pts_time:([0-9.]+)/g;

/** Parse ffmpeg's `Duration: HH:MM:SS.ff` line into seconds, or `null` when
 * absent/malformed (an unreadable container, or an unexpected stderr shape). */
export function parseDurationSeconds(stderr: string): number | null {
  const m = DURATION_RE.exec(stderr);
  if (!m) return null;
  const [, h, min, s, frac] = m;
  const seconds = Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(`0.${frac ?? '0'}`);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Parse every `showinfo` filter line's `pts_time` into ascending seconds,
 * in the order ffmpeg emitted them (== decode order, which for
 * `-skip_frame nokey` output is presentation order of the kept frames). */
export function parseShowinfoPtsTimes(stderr: string): number[] {
  const out: number[] = [];
  for (const m of stderr.matchAll(SHOWINFO_PTS_RE)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** Split ffmpeg's rawvideo stdout into one `DIFF_THUMB_BYTES` RGB24 chunk
 * per decoded frame. Drops a short trailing partial chunk (a process killed
 * mid-frame at the timeout) rather than throwing. */
function splitThumbnails(raw: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset + DIFF_THUMB_BYTES <= raw.length; offset += DIFF_THUMB_BYTES) {
    out.push(raw.subarray(offset, offset + DIFF_THUMB_BYTES));
  }
  return out;
}

/**
 * Probe `videoPath` for duration and up to `MAX_CANDIDATE_FRAMES` ordered
 * keyframe candidates with their difference thumbnails.
 *
 * Returns `null` when ffmpeg is unavailable, the process times out, or the
 * container carries no readable duration (no video stream / malformed
 * input) — every one of those is the caller's cue for a terminal
 * `no-decodable-frame`-class skip, never a throw, matching the module's
 * "never assume a client has ffmpeg" convention (`video-poster.ts`).
 */
export async function probeVideo(videoPath: string): Promise<VideoProbeResult | null> {
  const bin = await ffmpegBinary();
  if (!bin) return null;

  const args = [
    '-hide_banner',
    '-loglevel',
    'info',
    '-skip_frame',
    'nokey',
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-frames:v',
    String(MAX_CANDIDATE_FRAMES),
    '-vf',
    `showinfo,scale=${DIFF_THUMB_SIDE}:${DIFF_THUMB_SIDE}`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ];

  let timedOut = false;
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, PROBE_TIMEOUT_MS);

    let stdout: Buffer;
    let stderr: string;
    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).arrayBuffer().then((b) => Buffer.from(b)),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      log.warn({ videoPath, timeoutMs: PROBE_TIMEOUT_MS }, 'probe timed out');
      return null;
    }

    const durationSec = parseDurationSeconds(stderr);
    if (durationSec === null) {
      log.debug({ videoPath, stderr: stderr.trim().slice(0, 300) }, 'no readable duration');
      return null;
    }

    const timestamps = parseShowinfoPtsTimes(stderr);
    const thumbs = splitThumbnails(stdout);
    const count = Math.min(timestamps.length, thumbs.length);
    const candidates: FrameCandidate[] = [];
    for (let i = 0; i < count; i++) {
      candidates.push({ timestampSec: timestamps[i]!, diffThumb: thumbs[i]! });
    }
    return { durationSec, candidates };
  } catch (e) {
    log.warn({ videoPath, err: e instanceof Error ? e.message : e }, 'probe threw');
    return null;
  }
}
