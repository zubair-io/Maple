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
import { probeCommand } from '../process/probe-command.ts';

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

/** The resolved binary, once a probe has actually found a runnable one.
 * Positive results are cached for the process lifetime — a binary that ran a
 * moment ago doesn't stop existing, and this sits on the hot path of every
 * video thumb. */
let resolved: string | null = null;
/** In-flight probe, so concurrent stage handlers share one detection pass
 * rather than each spawning their own. Cleared when it settles. */
let inflight: Promise<string | null> | null = null;

/**
 * Resolve a runnable ffmpeg binary, or null when the host has none.
 *
 * A NEGATIVE result is deliberately not cached. Caching "absent" for the
 * process lifetime would mean an operator who installs ffmpeg on a running
 * server gets no posters until they restart it — and, worse, could burn the
 * `rearm-video-posters` marker on a pass that skipped every asset (see that
 * migration's hold-off). Re-probing while absent makes the install take effect
 * on its own.
 *
 * The re-probe is cheap in the case that matters: with no ffmpeg on the host,
 * `Bun.which` is a no-op and each absolute candidate fails the exec without
 * forking a process. A binary that exists but cannot run (the dangling-dylib
 * case) does cost one fork per probe, but that is a broken install the
 * operator should repair, not a steady state to optimize for.
 */
export function ffmpegBinary(): Promise<string | null> {
  if (resolved !== null) return Promise.resolve(resolved);
  inflight ??= detectFfmpeg().then((found) => {
    resolved = found;
    inflight = null;
    return found;
  });
  return inflight;
}

/** True once the "no ffmpeg" line has been logged. Absence is re-probed on
 * every call, so without this a host that simply has no ffmpeg would emit the
 * same warning once per video asset. */
let loggedAbsent = false;

async function detectFfmpeg(): Promise<string | null> {
  const onPath = Bun.which('ffmpeg');
  const candidates = onPath ? [onPath, ...FALLBACK_PATHS] : [...FALLBACK_PATHS];

  for (const candidate of candidates) {
    if (await isRunnable(candidate)) {
      log.info({ ffmpeg: candidate }, 'video poster support enabled');
      loggedAbsent = false;
      return candidate;
    }
  }

  if (!loggedAbsent) {
    loggedAbsent = true;
    log.info(
      { probed: candidates },
      'no runnable ffmpeg found — video posters disabled. Install ffmpeg (no restart needed), ' +
        'then run the "Re-arm video posters" migration in Settings → Workers to render posters ' +
        'for videos already indexed.',
    );
  }
  return null;
}

/**
 * True when `bin` exists AND actually executes. The execution half is the
 * point — see the module doc comment on dangling-dylib installs.
 */
async function isRunnable(bin: string): Promise<boolean> {
  return probeCommand(bin, ['-version']);
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
