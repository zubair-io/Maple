/**
 * Describe (caption + structured vision) stage.
 *
 * Calls a vision LLM via the describe-provider abstraction (default:
 * Ollama serving qwen2.5-vl:7b) against the 1280-px preview produced
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
 * Spec: `docs/superpowers/specs/2026-05-19-qwen-vision-ocr-design.md`.
 */

import { readFile } from "node:fs/promises";
import type { ImageDoc, StageContext, StageResult } from "../runtime/define-stage.ts";
import { defineStage } from "../runtime/define-stage.ts";
import { cachePathFor } from "../../fs/xmp.ts";
import {
  type DescribeProvider,
  getDescribeProvider,
} from "../../enrichment/describe-providers/index.ts";
import {
  loadEnrichmentConfig,
  resolveEnrichmentConfig,
  DEFAULT_DESCRIBE_VISION_PROMPT,
  DESCRIBE_VISION_PROMPT_VERSION,
} from "../../enrichment/enrichment-config.repo.ts";
import {
  parseVisionJson,
  strippedRawFor,
} from "../../enrichment/describe-providers/parse-vision-json.ts";
import { PREVIEW_SIZE_KEY } from "../../indexer/previewer.ts";

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

/** Fixed model. The structured-JSON parser only accepts qwen2.5-vl's
 * output shape, so allowing operator overrides would silently dead-letter
 * every row. Operators can still point at a remote Ollama via the URL
 * config, but provider/model/prompt are locked. */
const FIXED_DESCRIBE_MODEL = "qwen2.5-vl:7b";

async function getDeps(): Promise<DescribeDeps> {
  if (_deps) return _deps;
  const dbConfig = await loadEnrichmentConfig();
  const cfg = resolveEnrichmentConfig(dbConfig);
  // Provider is locked to Ollama; only the URL is configurable so the
  // operator can run the model on a remote box. Stale `describe_provider`
  // / `describe_model` / `describe_system_prompt` values in the DB row are
  // ignored — kept on the type only so older config docs don't error on
  // parse.
  const provider = getDescribeProvider("ollama", {
    url: cfg.describe_provider_url,
  });
  _deps = {
    provider,
    systemPrompt: DEFAULT_DESCRIBE_VISION_PROMPT,
    model: FIXED_DESCRIBE_MODEL,
  };
  return _deps;
}

/** Test-only setter. Call with `null` to reset between tests. */
export function setDescribeDepsForTests(deps: DescribeDeps | null): void {
  _deps = deps;
}

export async function describeHandler(
  image: ImageDoc,
  _ctx: StageContext,
): Promise<StageResult> {
  const { provider, systemPrompt, model } = await getDeps();

  // 1280-px preview — VLMs need more pixels than the 512-px thumb to read
  // signs and small subjects. The preview stage produces this artefact;
  // its absence means either the preview stage hasn't run yet (DAG bug)
  // or the source asset has gone missing.
  const previewPath = cachePathFor(image.abs_path as string, "previews", PREVIEW_SIZE_KEY);
  let jpegBytes: Buffer;
  try {
    jpegBytes = await readFile(previewPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { skip: "preview-missing" };
    }
    throw err;
  }

  const result = await provider.describe(jpegBytes, { systemPrompt, model });

  // Strict parse — throws VisionParseError on malformed output. The runtime
  // dead-letters the row after maxAttempts; operators triage via
  // /settings/workers and see the truncated raw snippet in last_error.
  const vision = parseVisionJson(result.text);

  const now = new Date().toISOString();
  // Measure post-fence-strip so the recorded size matches what the parser
  // actually consumed, per VisionMeta.raw_response_size contract.
  const rawResponseSize = Buffer.byteLength(strippedRawFor(result.text), "utf8");

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
  patch.ocr_text = vision.text_visible ?? "";
  patch.ocr_meta = {
    engine: "qwen2.5-vl",
    engine_version: model,
    generated_at: now,
    // qwen2.5-vl has no per-token confidence the way a classic OCR engine does.
    mean_confidence: null,
  };

  return { patch };
}

export default defineStage({
  name: "describe",
  // v2: structured JSON output via DEFAULT_DESCRIBE_VISION_PROMPT, reads
  // the 1280-px preview, populates `vision` + `vision_meta`. v1 produced
  // free-text descriptions from `llava` against the 512-px thumb — bumping
  // the version invalidates those rows so they re-run with the new chain.
  targetVersion: 2,
  dependsOn: ["preview"],
  defaults: {
    concurrency: 2,
    pollIntervalMs: 1000,
    batchSize: 5,
    maxAttempts: 5,
    paused: false,
    last_seen_target_version: 0,
    pausedOnFirstBoot: true,
  },
  handler: describeHandler,
});
