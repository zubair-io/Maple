/**
 * Video poster-frame extraction via a platform `ffmpeg` binary (#1649).
 *
 * The thumb / preview tiers need a still image for every asset. RAW goes
 * through raw-ffi and bitmaps through the imgdecode child pool; video had no
 * decode path at all, so `.mov`/`.mp4` were skipped outright and the grid fell
 * back to a text badge. This module fills that hole by shelling out to
 * whatever `ffmpeg` the host provides.
 *
 * Shelling out — rather than bundling `@ffmpeg/ffmpeg` (~30 MB WASM) or
 * binding libav through `bun:ffi` — keeps the dependency footprint at zero for
 * deployments that don't care about video, and inherits process isolation for
 * free: a codec that segfaults takes down a short-lived child, not the API.
 * That mirrors why RAW decode lives behind `ffi-pool` and bitmaps behind
 * `imgdecode-pool`.
 *
 * The output here is a plain JPEG at a caller-owned temp path, NOT the final
 * cache artefact. Callers hand it straight to `renderImageThumbToFileViaPool`
 * so the resize + AVIF encode + `finalizeAvifRender` validate-then-publish gate
 * are byte-for-byte the same as every other format. Nothing about the video
 * path gets to bypass the gate that keeps non-image bytes out of the caches.
 *
 * Availability is probed by EXECUTING `ffmpeg -version`, never by stat-ing the
 * path. A binary can be present on `PATH` and still be unrunnable — a Homebrew
 * upgrade that leaves a dangling `libx265.*.dylib` behind is the case that
 * motivated this, and `which ffmpeg` reports success on exactly that machine.
 * A stat-based probe would mark every video permanently "processed, no poster."
 */

import * as fs from 'node:fs/promises';
import { child as childLogger } from '../log.ts';

const log = childLogger('video-poster');

/**
 * Where to seek before grabbing the frame. One second in avoids the fade-from-
 * black / auto-exposure ramp that opens most handheld clips, which otherwise
 * yields an all-black poster. Clips SHORTER than this seek produce no frame at
 * all, so `extractVideoPosterJpeg` retries from the first frame — see there.
 * Matches Apple's `ThumbnailLoader.posterAVIF` (#1642), which requests the same
 * timestamp clamped to asset duration.
 */
const SEEK_SECONDS = 1;

/**
 * Hard ceiling on a single ffmpeg invocation. A malformed container can send
 * ffmpeg hunting for a decodable frame indefinitely; without a kill it would
 * hold a stage concurrency slot forever and stall the worker. Generous enough
 * for a cold read of a large 4K clip off a spinning disk or a network share.
 */
const TIMEOUT_MS = 30_000;

/**
 * Absolute paths probed when `ffmpeg` isn't on `PATH`. Bun's `which` honours
 * the API process's environment, which under launchd / systemd is frequently
 * a bare `/usr/bin:/bin` that omits Homebrew and local installs — so a server
 * that has ffmpeg would otherwise look like one that doesn't.
 */
const FALLBACK_PATHS = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
  '/snap/bin/ffmpeg',
] as const;

/** Cached probe. `null` once resolved-and-absent; the promise is memoized so
 * concurrent stage handlers share one probe rather than spawning N processes. */
let probe: Promise<string | null> | null = null;

/**
 * Resolve a runnable ffmpeg binary, or null when the host has none.
 *
 * Memoized for process lifetime: this runs on the hot path of every video
 * thumb, and the answer only changes when an operator installs or removes
 * ffmpeg — which is a restart-or-re-arm event either way (see the
 * `rearm-video-posters` migration).
 */
export function ffmpegBinary(): Promise<string | null> {
  probe ??= detectFfmpeg();
  return probe;
}

/** Drop the memoized probe. Tests only — production has no reason to re-probe
 * within a process lifetime. */
export function resetFfmpegProbeForTest(): void {
  probe = null;
}

async function detectFfmpeg(): Promise<string | null> {
  const onPath = Bun.which('ffmpeg');
  const candidates = onPath ? [onPath, ...FALLBACK_PATHS] : [...FALLBACK_PATHS];

  for (const candidate of candidates) {
    if (await isRunnable(candidate)) {
      log.info({ ffmpeg: candidate }, 'video poster support enabled');
      return candidate;
    }
  }

  log.info(
    { probed: candidates },
    'no runnable ffmpeg found — video posters disabled. Install ffmpeg, then run the ' +
      '"Re-arm video posters" migration in Settings → Workers to render posters for existing videos.',
  );
  return null;
}

/**
 * True when `bin` exists AND actually executes. The execution half is the
 * point — see the module doc comment on dangling-dylib installs.
 */
async function isRunnable(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, '-version'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const timer = setTimeout(() => proc.kill(), 5_000);
    try {
      return (await proc.exited) === 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // ENOENT / EACCES / not executable — this candidate is simply not it.
    return false;
  }
}

/**
 * Extract a single poster frame from `videoPath` and write it to
 * `outJpegPath`. Returns false — never throws — when the host has no ffmpeg,
 * when the container holds no decodable video stream, or when extraction times
 * out; the caller treats that exactly like any other failed render branch.
 *
 * `outJpegPath` is a caller-owned temp path. On failure nothing is left behind
 * at that path.
 */
export async function extractVideoPosterJpeg(
  videoPath: string,
  outJpegPath: string,
): Promise<boolean> {
  const bin = await ffmpegBinary();
  if (!bin) return false;

  // Seek first, then fall back to the very first frame. A clip shorter than
  // SEEK_SECONDS leaves ffmpeg past EOF, where it exits 0 having written
  // nothing — which is why success is judged on the output file being present
  // and non-empty rather than on the exit code alone.
  if (await runFfmpeg(bin, videoPath, outJpegPath, SEEK_SECONDS)) return true;
  return await runFfmpeg(bin, videoPath, outJpegPath, 0);
}

async function runFfmpeg(
  bin: string,
  videoPath: string,
  outJpegPath: string,
  seekSeconds: number,
): Promise<boolean> {
  // `-ss` BEFORE `-i` is the fast path: ffmpeg seeks the container directly
  // instead of decoding-and-discarding every frame up to the timestamp, which
  // on a long clip is the difference between milliseconds and minutes.
  //
  // `-map 0:v:0` pins the first video stream — without it a file carrying a
  // cover-art / thumbnail stream can yield that instead of real footage.
  // `-an`/`-sn` drop audio and subtitles. `-frames:v 1` stops after one frame.
  // Rotation from the container's display matrix is applied by default, which
  // is what the thumb contract wants: orientation baked into the pixels.
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-frames:v',
    '1',
    // q:v 2 is near-visually-lossless for JPEG. This intermediate is re-encoded
    // to AVIF immediately downstream, so spending bits here costs a few hundred
    // KB of temp file and avoids compounding two lossy passes.
    '-q:v',
    '2',
    '-f',
    'image2',
    '-y',
    outJpegPath,
  ];

  const timedOut = { value: false };
  try {
    const proc = Bun.spawn([bin, ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => {
      timedOut.value = true;
      proc.kill();
    }, TIMEOUT_MS);

    const [exitCode, stderr] = await (async () => {
      try {
        const text = await new Response(proc.stderr).text();
        return [await proc.exited, text] as const;
      } finally {
        clearTimeout(timer);
      }
    })();

    if (timedOut.value) {
      log.warn({ videoPath, timeoutMs: TIMEOUT_MS }, 'ffmpeg timed out');
      await discard(outJpegPath);
      return false;
    }

    // Exit code alone is not sufficient — see the short-clip note in
    // `extractVideoPosterJpeg`. Require real bytes on disk.
    if (exitCode === 0 && (await hasBytes(outJpegPath))) return true;

    // A failed seek attempt is expected for sub-second clips, so it logs at
    // debug; the caller retries from frame 0 and only that failure is notable.
    const detail = {
      videoPath,
      exitCode,
      seekSeconds,
      stderr: stderr.trim().slice(0, 500),
    };
    if (seekSeconds > 0) {
      log.debug(detail, 'ffmpeg produced no frame at seek — retrying from start');
    } else {
      log.warn(detail, 'ffmpeg produced no poster frame');
    }
    await discard(outJpegPath);
    return false;
  } catch (e) {
    log.warn({ videoPath, err: e instanceof Error ? e.message : e }, 'ffmpeg spawn threw');
    await discard(outJpegPath);
    return false;
  }
}

async function hasBytes(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).size > 0;
  } catch {
    return false;
  }
}

/** Remove a partial/empty output so a retry starts clean and no zero-byte file
 * is mistaken for a rendered poster. Best-effort by design. */
async function discard(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* nothing written, or already gone */
  }
}
