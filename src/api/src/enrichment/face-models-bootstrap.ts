/**
 * antelopev2 zero-config bootstrap.
 *
 * Split out of `face-models.ts` to keep that file under the 600-LOC
 * budget. `loadFaceModels()` calls `downloadAntelopeV2Default()` when
 * neither model file is on disk and neither URL is configured — i.e.
 * the "personal install, just works at boot" path.
 *
 * Why antelopev2 (not buffalo_l): buffalo_l ships ArcFace R50 trained on
 * WebFace600K (filename gives it away: `w600k_r50.onnx`). antelopev2
 * ships the real R100 trained on Glint360K (`glintr100.onnx`), which is
 * the canonical high-quality InsightFace recognizer.
 *
 * Why this URL: InsightFace's GitHub Releases are the canonical source
 * for the `buffalo_*` and `antelopev2` bundles. The `v0.7` release is
 * the long-standing host for `antelopev2.zip`; if the project ever
 * rotates it, the download fails with a clear error and the operator
 * falls back to the configured URL fields on /settings/enrichment or
 * drops the files at `<modelDir>/{scrfd_10g,arcface_r100_glint360k}.onnx`
 * manually.
 *
 * Why shell out to `unzip`: avoids pulling a JS unzip dep just for one
 * boot-time path. `unzip` is preinstalled on every mainstream Linux
 * distro and the official Bun Docker image. If it's missing, the error
 * is clearly actionable (`apt install unzip`).
 */

import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { child as childLogger } from '../log.ts';

const execFileAsync = promisify(execFile);
const log = childLogger('enrichment:face-models');

export const DEFAULT_ANTELOPEV2_URL =
  'https://github.com/deepinsight/insightface/releases/download/v0.7/antelopev2.zip';

/**
 * Canonical SHA256 for `antelopev2.zip` on the InsightFace v0.7 release.
 *
 * Verified 2026-05-25 against the actual release asset (360,662,982 bytes,
 * last-modified 2024-08-12). The download path always checks the streamed
 * bytes against this hash and rejects a mismatch (rotated bundle or
 * corrupted download). Operators who want to pin a different bundle should
 * pre-stage the files and set MAPLE_FACE_DETECTOR_URL /
 * MAPLE_FACE_RECOGNIZER_URL with their own explicit SHA256s instead.
 */
export const DEFAULT_ANTELOPEV2_SHA256 =
  '8e182f14fc6e80b3bfa375b33eb6cff7ee05d8ef7633e738d1c89021dcf0c5c5';

/** Member names inside `antelopev2.zip` (paths the InsightFace bundle uses).
 *
 * The detector is the same SCRFD-10G architecture as buffalo_l's
 * `det_10g.onnx`, just renamed to advertise that the export includes
 * keypoint heads (`bnkps` = batchnorm + keypoints). The recognizer is
 * the canonical Glint360K R100 weights — distinct from buffalo_l's R50. */
const ANTELOPEV2_DET_MEMBER = 'scrfd_10g_bnkps.onnx';
const ANTELOPEV2_REC_MEMBER = 'glintr100.onnx';

/** Download `antelopev2.zip` and extract its detector + recognizer ONNX
 * files into `dir` under `detectorBasename` / `recognizerBasename`.
 *
 * Caller (`loadFaceModels`) is responsible for the precondition check
 * (neither file on disk and no URL configured); this function always
 * downloads. */
export async function downloadAntelopeV2Default(
  dir: string,
  detectorBasename: string,
  recognizerBasename: string,
): Promise<void> {
  log.info(
    { url: DEFAULT_ANTELOPEV2_URL, dir },
    'no face models on disk and no URL configured — downloading antelopev2 default bundle',
  );

  // Stream the zip to disk with incremental SHA256 hashing. Buffering
  // the full ~360 MB into RSS via arrayBuffer() risks OOM in
  // constrained containers (a 512 MB memory limit is plausible on a
  // single-board Self Hosted deploy). Chunk-by-chunk keeps peak memory
  // bounded by the file system's write-buffer, not the bundle size.
  const res = await fetch(DEFAULT_ANTELOPEV2_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch antelopev2 default bundle from ${DEFAULT_ANTELOPEV2_URL}: HTTP ${res.status}. ` +
        `Either set MAPLE_FACE_DETECTOR_URL / MAPLE_FACE_RECOGNIZER_URL, ` +
        `or drop the model files at ${join(dir, detectorBasename)} and ${join(dir, recognizerBasename)}.`,
    );
  }
  if (!res.body) {
    throw new Error(`antelopev2 fetch returned no body (HTTP ${res.status})`);
  }
  const zipPath = join(dir, '_antelopev2.zip');
  const sink = createWriteStream(zipPath);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of res.body as ReadableStream<Uint8Array>) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (!sink.write(chunk)) {
        // Honour backpressure so a slow disk doesn't let the in-flight
        // chunk queue grow unbounded in memory.
        await new Promise<void>((resolve) => sink.once('drain', () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    // Partial file is unusable; remove so the next attempt re-downloads.
    sink.destroy();
    rmSync(zipPath, { force: true });
    throw err;
  }
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== DEFAULT_ANTELOPEV2_SHA256.toLowerCase()) {
    rmSync(zipPath, { force: true });
    throw new Error(
      `SHA256 mismatch for antelopev2.zip: expected ${DEFAULT_ANTELOPEV2_SHA256}, got ${actual}. ` +
        `InsightFace may have rotated the bundle, or this is a corrupted download. ` +
        `Set MAPLE_FACE_DETECTOR_URL / MAPLE_FACE_RECOGNIZER_URL to pin the model files yourself.`,
    );
  }
  log.info({ zipPath, bytes }, 'antelopev2 downloaded; extracting');

  // Extract into a staging dir so we can find the two files regardless
  // of whether the zip places them at the root or under `antelopev2/`.
  const stagingDir = join(dir, '_antelopev2_extract');
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  try {
    await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', stagingDir]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to extract antelopev2.zip (${msg}). Install unzip (\`apt install unzip\`) ` +
        `or drop the model files at ${join(dir, detectorBasename)} and ${join(dir, recognizerBasename)} manually.`,
    );
  }

  const findMember = (member: string): string => {
    for (const candidate of [join(stagingDir, member), join(stagingDir, 'antelopev2', member)]) {
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(
      `antelopev2.zip did not contain ${member} — InsightFace may have rotated the bundle. ` +
        `Set MAPLE_FACE_DETECTOR_URL / MAPLE_FACE_RECOGNIZER_URL with explicit URLs.`,
    );
  };

  copyFileSync(findMember(ANTELOPEV2_DET_MEMBER), join(dir, detectorBasename));
  copyFileSync(findMember(ANTELOPEV2_REC_MEMBER), join(dir, recognizerBasename));

  // Cleanup so we don't leave the zip + extraction droppings under the
  // model dir (would survive container rebuilds via the volume mount).
  rmSync(zipPath, { force: true });
  rmSync(stagingDir, { recursive: true, force: true });

  log.info(
    {
      detector: join(dir, detectorBasename),
      recognizer: join(dir, recognizerBasename),
    },
    'antelopev2 default bundle extracted',
  );
}
