/**
 * Describe (caption + structured vision) stage.
 *
 * Calls a vision LLM via the describe-provider abstraction (default:
 * Ollama serving qwen2.5vl:7b) against the 1280-px preview produced
 * by the preview stage, parses the structured-JSON response into a
 * typed `VisionDoc`, and writes:
 *
 *   description       — the caption string (legacy free-text mirror)
 *   description_meta  — { provider, model, prompt_version, generated_at, cost_usd, … }
 *   vision            — full structured VisionDoc
 *   vision_meta       — { provider, model, prompt_version, generated_at, raw_response_size }
 *   ocr_text          — mirrored from vision.text_visible
 *   ocr_meta          — { engine: "qwen2.5-vl", … } — qwen2.5-vl is the sole OCR source
 *
 * On a parse failure the handler re-throws `VisionParseError`; the runtime
 * stamps the message into `stages.describe.last_error` and increments
 * `attempts`. When `attempts >= maxAttempts` the row is marked dead and
 * the operator triages it in `/settings/workers`.
 *
 * `pausedOnFirstBoot: true` — describe still hits an external endpoint
 * (Ollama on localhost or a paid provider). Operator unpauses from the
 * settings UI once they've confirmed the model is available.
 *
 * Provider, systemPrompt, and model are resolved from the persisted
 * enrichment config at first use and cached as module-level singletons.
 * Tests inject dependencies via `setDescribeDepsForTests`.
 *
 * Spec: `.archived-plans/specs/2026-05-19-qwen-vision-ocr-design.md`.
 */

import { readFile } from 'node:fs/promises';
import type { ImageDoc, StageContext, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { relocateBackupScreenshot } from '../migration/refile-backups.ts';
import {
  type DescribeProvider,
  getDescribeProvider,
} from '../../enrichment/describe-providers/index.ts';
import { writeHiddenMarker } from '../../fs/hidden-marker.ts';
import { findBurstSiblings } from '../../enrichment/burst-siblings.ts';
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  DEFAULT_DESCRIBE_VISION_PROMPT,
  DESCRIBE_VISION_PROMPT_VERSION,
  QWEN_VL_OLLAMA_TAG,
} from '../../enrichment/enrichment-config.repo.ts';
import {
  parseVisionJson,
  strippedRawFor,
  VISION_DOC_JSON_SCHEMA,
} from '../../enrichment/describe-providers/parse-vision-json.ts';
import { PREVIEW_SIZE_KEY } from '../../indexer/previewer.ts';
import { coll } from '../../indexer/images.repo.ts';

/**
 * Prompt version stamped on both `description_meta.prompt_version` and
 * `vision_meta.prompt_version`. Tied to `DESCRIBE_VISION_PROMPT_VERSION`
 * — the stage and the prompt constant are versioned together so a
 * prompt edit forces re-run on every existing row.
 */
export const DESCRIBE_PROMPT_VERSION = DESCRIBE_VISION_PROMPT_VERSION;

interface DescribeDeps {
  provider: DescribeProvider;
  systemPrompt: string;
  model: string;
}

let _deps: DescribeDeps | null = null;

/** Fixed model — sourced from the single shared constant so the stage,
 * the bootstrap health-check, and the UI copy can't drift. The
 * structured-JSON parser only accepts qwen2.5-VL's output shape, so
 * allowing operator overrides would silently dead-letter every row.
 * Operators can still point at a remote Ollama via the URL config, but
 * provider/model/prompt are locked. */
const FIXED_DESCRIBE_MODEL = QWEN_VL_OLLAMA_TAG;

async function getDeps(): Promise<DescribeDeps> {
  if (_deps) return _deps;
  const dbConfig = await loadEnrichmentConfig();
  const cfg = resolveEnrichmentConfig(dbConfig);
  // Provider is locked to Ollama; only the URL is configurable so the
  // operator can run the model on a remote box. Stale `describe_provider`
  // / `describe_model` / `describe_system_prompt` values in the DB row are
  // ignored — kept on the type only so older config docs don't error on
  // parse.
  const provider = getDescribeProvider('ollama', {
    url: cfg.describe_provider_url,
  });
  _deps = {
    provider,
    systemPrompt: DEFAULT_DESCRIBE_VISION_PROMPT,
    model: FIXED_DESCRIBE_MODEL,
  };
  return _deps;
}

/** Invalidate the module-level deps cache so the next `getDeps()` call
 * re-reads `describe_provider_url` from the persisted config. Wired into
 * `applyDescribeConfig` so an operator changing the URL in
 * `/settings/enrichment` takes effect without restarting the process. */
export function resetDescribeDeps(): void {
  _deps = null;
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setDescribeDepsForTests(deps: DescribeDeps | null): void {
  _deps = deps;
}

export async function describeHandler(image: ImageDoc, ctx: StageContext): Promise<StageResult> {
  // Video containers have no still frame for the vision model to caption.
  // They reach this stage because the library can hold mixed media (the
  // backup-ingest route has no extension allowlist), and the preview stage's
  // last-resort path copies the source bytes verbatim — so the "preview" on
  // disk is the raw .MOV, not a JPEG. Handing that to Ollama wastes an
  // inference slot at best and OOMs / 500s the server at worst (the symptom
  // that surfaced this bug). Skip terminally, before resolving deps or
  // touching disk. `skip` writes version = targetVersion, so the row is
  // marked done and never reclaimed.
  const primary = assetPrimaryFileInfo(image);
  if (primary && isVideoFilename(primary.filename)) {
    return { skip: 'video-file' };
  }

  const { provider, systemPrompt, model } = await getDeps();

  // 1280-px preview — VLMs need more pixels than the 512-px thumb to read
  // signs and small subjects. The preview stage produces this artefact;
  // its absence means either the preview stage hasn't run yet (DAG bug)
  // or the source asset has gone missing.
  //
  // Content-addressed preview path. The legacy `abs_path` field was
  // retired in the drop-abs-path-2026-05-21 migration; rows without
  // `fileinfo` are skipped.
  //
  // Let `loadLibraryRoots()` errors propagate — a transient DB hiccup would
  // otherwise yield an empty libs map, which would make `cachePathForAsset`
  // return null and trip the no-resolvable-location skip below. That skip
  // writes `version = targetVersion` (see run-stage.ts), permanently
  // marking the stage done. By throwing, the runner's retry/backoff path
  // handles the transient case. Reserve `skip` for the genuine case:
  // libraries loaded fine, but the asset has no fileinfo[0] or its library
  // is unregistered.
  const libs = await loadLibraryRoots();
  const absPath = assetAbsPath(image, libs);
  const previewPath = cachePathForAsset(image as never, libs, 'previews', PREVIEW_SIZE_KEY);
  if (!previewPath) {
    return { skip: 'no-resolvable-location' };
  }
  let jpegBytes: Buffer;
  try {
    jpegBytes = await readFile(previewPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { skip: 'preview-missing' };
    }
    throw err;
  }

  const result = await provider.describe(jpegBytes, {
    systemPrompt,
    model,
    // Constrain Ollama's output to the VisionDoc schema. Ollama 0.5+
    // enforces this at decode time, so the model cannot emit out-of-enum
    // values, drop required fields, or produce malformed JSON. The
    // parse-vision-json synonym maps stay as defense in depth for older
    // Ollama versions and edge cases.
    format: VISION_DOC_JSON_SCHEMA,
  });

  // Strict parse — throws VisionParseError on malformed output. The runtime
  // dead-letters the row after maxAttempts; operators triage via
  // /settings/workers and see the truncated raw snippet in last_error.
  const vision = parseVisionJson(result.text);

  const now = new Date().toISOString();
  // Measure post-fence-strip so the recorded size matches what the parser
  // actually consumed, per VisionMeta.raw_response_size contract.
  const rawResponseSize = Buffer.byteLength(strippedRawFor(result.text), 'utf8');

  const patch: Record<string, unknown> = {
    // Free-text caption mirror — legacy clients still read `description`.
    description: vision.caption,
    description_meta: {
      provider: provider.name,
      model,
      prompt_version: DESCRIBE_PROMPT_VERSION,
      generated_at: now,
      cost_usd: result.cost_usd,
      ...result.provider_info,
    },
    // Structured vision subdoc — the new canonical source.
    vision,
    vision_meta: {
      provider: provider.name,
      model,
      prompt_version: DESCRIBE_PROMPT_VERSION,
      generated_at: now,
      raw_response_size: rawResponseSize,
    },
    // Top-level mirror of the VLM's screenshot verdict, overwriting any
    // exif-stage heuristic. The describe stage has more signal than
    // filename + missing camera_make (it sees cropped screenshots and
    // photos-of-screens correctly), so its verdict wins.
    is_screenshot: vision.is_screenshot,
  };

  // OCR mirror: the structured vision pass extracts visible text as part
  // of captioning, so we populate ocr_text from vision.text_visible. qwen2.5-vl
  // is the sole OCR source; the engine field is always the literal "qwen2.5-vl".
  patch.ocr_text = vision.text_visible ?? '';
  patch.ocr_meta = {
    engine: 'qwen2.5-vl',
    engine_version: model,
    generated_at: now,
    // qwen2.5-vl has no per-token confidence the way a classic OCR engine does.
    mean_confidence: null,
  };

  // The VLM verdict is the authoritative screenshot signal. If it flags a
  // backup-origin asset the ingest filename heuristic missed, file it under
  // <year>/Screenshot now (rather than waiting for an operator to re-run the
  // screenshot migration). Best-effort: a move failure must never fail the
  // describe stage — the migration is the backstop. The early `phasset_links`
  // gate keeps non-backup assets (and unit-test docs) off the DB path entirely.
  // moveBackupAsset repoints fileinfo: [{ library_id: new ObjectId('5f8d04dc5b6e680017a42163'), path: 'sub', filename: 'img.dng', deleted_at: null }],
  // and the stage write don't collide.
  if (vision.is_screenshot && (image.phasset_links?.length ?? 0) > 0) {
    try {
      const outcome = await relocateBackupScreenshot(image._id);
      if (outcome === 'moved') {
        ctx.log.info(
          { assetId: image._id.toHexString() },
          'filed screenshot under year/Screenshot (describe verdict)',
        );
      }
    } catch (err) {
      ctx.log.warn(
        { assetId: image._id.toHexString(), err: err instanceof Error ? err.message : err },
        'screenshot relocation failed — left for the screenshot migration',
      );
    }
  }

  // Nudity auto-hide safety net
  if (vision.nudity_detected) {
    patch.hidden = true;
    if (image.hidden_reason !== 'manual') {
      patch.hidden_reason = 'nudity';
      patch.hidden_ack = false;
    }

    // Call writeHiddenMarker on the main asset
    if (absPath) {
      await writeHiddenMarker(absPath);
    }

    // Burst propagation: if it wasn't already hidden
    if (image.hidden !== true) {
      try {
        const assets = await coll();
        const siblings = await findBurstSiblings(assets, image as any);
        if (siblings.length > 0) {
          const siblingIds = siblings.map((s) => s._id);
          await assets.updateMany(
            { _id: { $in: siblingIds }, hidden: { $ne: true } },
            {
              $set: {
                hidden: true,
                hidden_reason: 'nudity-burst',
                hidden_ack: false,
              },
            },
          );

          // Write hidden markers for siblings
          for (const sib of siblings) {
            const sibAbsPath = assetAbsPath(sib, libs);
            if (sibAbsPath) {
              await writeHiddenMarker(sibAbsPath);
            }
          }
          ctx.log.info(
            { assetId: image._id.toHexString(), siblingCount: siblings.length },
            'describe: propagated nudity-hide to burst siblings',
          );
        }
      } catch (err) {
        ctx.log.warn(
          { assetId: image._id.toHexString(), err: err instanceof Error ? err.message : err },
          'describe: burst sibling propagation failed',
        );
      }
    }
  }

  return { patch };
}

const describeStage = defineStage({
  name: 'describe',
  // v2: structured JSON output via DEFAULT_DESCRIBE_VISION_PROMPT, reads
  // the 1280-px preview, populates `vision` + `vision_meta`. v1 produced
  // free-text descriptions from `llava` against the 512-px thumb — bumping
  // the version invalidates those rows so they re-run with the new chain.
  //
  // v3: adds the `is_screenshot` boolean to the prompt + parser + writes
  // it to `vision.is_screenshot` and the top-level `is_screenshot` mirror.
  // The runtime gates re-runs on this number (not on
  // `DESCRIBE_VISION_PROMPT_VERSION`), so bumping it forces every v2 row
  // to re-run and pick up the new field.
  //
  // v4: tolerant enum coercion (synonym maps + null-defaults) for
  // scene_type / time_of_day / lighting / weather / composition /
  // shot_type / indoor_outdoor, plus `null → []` for subjects / colors /
  // notable_objects. v3 rows whose enum value qwen drifted on
  // (e.g. "partly cloudy", "day") would have parsed OK at write-time
  // but were dead-lettered at re-run; bumping forces every v3 row to
  // re-attempt with the relaxed parser.
  // v5: adds nudity detection, auto-hiding safety net, and temporal burst propagation.
  targetVersion: 5,
  dependsOn: ['preview'],
  defaults: {
    concurrency: 2,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: describeHandler,
});

export default describeStage;

export async function startDescribeStage(): Promise<RunStageHandle> {
  return runStage(describeStage);
}
