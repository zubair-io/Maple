/**
 * Persisted enrichment runtime config. Mirrors the `indexer-config` shape:
 * a single document in `app_settings` keyed by `_id: "enrichment"`.
 *
 * The values here override the env vars (`MAPLE_NOMINATIM_URL`,
 * `MAPLE_GEOCODE_WORKER_ENABLED`, `MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC`,
 * plus the `MAPLE_DESCRIBE_*` family for the describe worker) at boot —
 * env vars stay as a fallback so existing deployments don't break when no
 * row has been written yet.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';
import type { DescribeProviderName } from './describe-providers/index.ts';
// Prompt text + version live in a sibling module (keeps this file under the
// file-size budget). Imported here so the resolver can use the system prompt,
// and re-exported below so existing importers keep importing them from here.
import {
  DEFAULT_DESCRIBE_SYSTEM_PROMPT,
  DEFAULT_DESCRIBE_VISION_PROMPT,
  DESCRIBE_VISION_PROMPT_VERSION,
} from './describe-prompts.ts';

const COLL = 'app_settings';
const DOC_ID = 'enrichment';
const log = childLogger('enrichment:config-repo');

/** Default model directory used by the face worker. Mirrors
 * `face-models.ts:defaultModelDir()` so the resolver and the worker
 * agree without a circular import. Exported so the sibling resolve
 * module (`enrichment-config.resolve.ts`) can reuse it. */
export function builtinModelDir(): string {
  return join(homedir(), '.maple', 'models');
}

/** Default sustained Nominatim rate when no DB row and no env var is set.
 * Matches `nominatim-client.ts:DEFAULT_RATE_LIMIT` so behaviour is identical
 * before and after the operator-configurable surface lands. */
export const DEFAULT_NOMINATIM_RATE_LIMIT_PER_SEC = 10;

/** Reject obviously broken values up-front. The lower bound is non-zero so
 * a misclick can't pause the worker silently; the upper bound is generous
 * enough to drive a high-end Nominatim deployment but tight enough to flag
 * an accidental three-digit input. */
export const MIN_NOMINATIM_RATE_LIMIT_PER_SEC = 0.1;
export const MAX_NOMINATIM_RATE_LIMIT_PER_SEC = 100;

/** Default minimum face size, as a fraction of the 640-px detection frame.
 * A detection whose shorter bbox side is below this threshold is dropped
 * before persisting — upscaling such tiny crops to 112×112 for the ArcFace
 * recogniser yields garbage embeddings that pollute people-clustering.
 * 0.06 ≈ 38 px on the 640-px input. Operators can lower to 0 to disable
 * the gate entirely, or raise it to filter out faces too small to cluster
 * reliably. */
export const DEFAULT_FACE_MIN_DETECTION_SIZE = 0.06;
/** Must be in [0, 1). Zero disables the filter; one would drop every
 * detection, so the upper bound is exclusive — the route rejects >= 1. */
export const MIN_FACE_MIN_DETECTION_SIZE = 0;
export const MAX_FACE_MIN_DETECTION_SIZE = 1;

/** Defaults for the describe worker. The local Ollama default keeps Maple's
 * Self Hosted deploy working out of the box without an API key. */
export const DEFAULT_DESCRIBE_PROVIDER: DescribeProviderName = 'ollama';
export const DEFAULT_DESCRIBE_OLLAMA_URL = 'http://localhost:11434';

/**
 * Ollama library tag for the locked vision model. The qwen2.5 generation's
 * Ollama tag was dashless (`qwen2.5vl:7b`) while the HuggingFace form
 * (`qwen2.5-vl:7b`) 404'd. The qwen3 generation reverses this: the Ollama
 * tag IS dashed (`qwen3-vl:8b`). Requires Ollama >= 0.12.7. Single source
 * of truth so the stage handler, the bootstrap health check, and the UI
 * copy can't drift.
 *
 * `ocr_meta.engine` (a Maple-internal discriminator) is unrelated and stays
 * the literal `"qwen2.5-vl"` (historical name) — changing it would
 * invalidate every existing DB row. The concrete model tag travels in
 * `engine_version` instead.
 */
export const QWEN_VL_OLLAMA_TAG = 'qwen3-vl:8b';

export const DEFAULT_DESCRIBE_MODELS: Record<DescribeProviderName, string> = {
  // Default to the Ollama qwen3-VL 8B tag (see QWEN_VL_OLLAMA_TAG above).
  // Produces structured JSON matching DEFAULT_DESCRIBE_VISION_PROMPT below.
  // The previous "llava:latest" default produced free-text captions
  // incompatible with the parser; qwen2.5-vl:7b was the prior generation's
  // pick before the qwen3-vl:8b upgrade.
  ollama: QWEN_VL_OLLAMA_TAG,
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-flash',
};

// Re-export the prompt constants (imported above) so existing importers
// (`describe.ts`, the parse-vision-json test) keep importing them from here.
export {
  DEFAULT_DESCRIBE_SYSTEM_PROMPT,
  DEFAULT_DESCRIBE_VISION_PROMPT,
  DESCRIBE_VISION_PROMPT_VERSION,
};

/** Daily USD spend cap for paid providers. The worker pauses (returns
 * `circuit-pause`) for the rest of the UTC day once the cap is hit. */
export const DEFAULT_DESCRIBE_DAILY_CAP_USD = 5;
/** Reject obviously broken cap values. Zero would silently pause the
 * worker forever; >1000 USD/day on a single deploy is almost certainly a
 * misclick (and the resulting damage rolls fast on a paid provider). */
export const MIN_DESCRIBE_DAILY_CAP_USD = 0;
export const MAX_DESCRIBE_DAILY_CAP_USD = 1000;

const ALL_PROVIDERS: ReadonlyArray<DescribeProviderName> = [
  'ollama',
  'anthropic',
  'openai',
  'gemini',
];

/** Validate a provider string. Returns the typed name or `null` if
 * unrecognised; the route uses this to reject bad PUT bodies. */
export function asDescribeProvider(raw: unknown): DescribeProviderName | null {
  if (typeof raw !== 'string') return null;
  return (ALL_PROVIDERS as ReadonlyArray<string>).includes(raw)
    ? (raw as DescribeProviderName)
    : null;
}

export interface EnrichmentConfig {
  nominatim_url: string | null;
  geocode_worker_enabled: boolean;
  /** Sustained Nominatim throttle (token-bucket refill rate). Per-process.
   * `null` when the operator hasn't saved an explicit value yet — the
   * resolver then falls back to env / default. */
  nominatim_rate_limit_per_sec?: number | null;
  // ── Describe worker (Phase 6) ────────────────────────────────────────
  /** When false, the describe worker loop is dormant. `null`/missing →
   * resolver falls back to env / default (default true). */
  describe_worker_enabled?: boolean | null;
  /** Vision-LLM provider. `null`/missing → defaults to Ollama. */
  describe_provider?: DescribeProviderName | null;
  /** Model id for the selected provider. `null`/missing → provider's
   * default model. */
  describe_model?: string | null;
  /** Caption-generation prompt. `null`/missing → built-in default. */
  describe_system_prompt?: string | null;
  /** Daily USD cap (UTC day). `null`/missing → default 5. */
  describe_daily_cap_usd?: number | null;
  /** Provider URL — only meaningful for Ollama. Ignored for paid
   * providers (their endpoints are hard-coded). `null`/missing → falls
   * back to env / built-in default. */
  describe_provider_url?: string | null;
  // ── Face worker (Phase 5) ────────────────────────────────────────────
  /** Phase 5 face worker. Default off — opt-in because the worker requires
   * SCRFD + ArcFace ONNX model files on disk (or downloadable from
   * operator-supplied URLs). `null` falls through to env / default. */
  face_worker_enabled?: boolean | null;
  /** Override for the model directory. `null` falls through to
   * `MAPLE_MODEL_DIR` / `~/.maple/models/`. */
  face_model_dir?: string | null;
  /** Operator-supplied download URLs + SHA256 verification for the
   * SCRFD-10G detector + ArcFace R100 recognizer. Used when files aren't
   * already on disk under `<face_model_dir>/{scrfd_10g,arcface_r100_glint360k}.onnx`. */
  face_detector_url?: string | null;
  face_detector_sha256?: string | null;
  face_recognizer_url?: string | null;
  face_recognizer_sha256?: string | null;
  /** Minimum face size filter (normalised [0, 1) on the 640-px detection
   * frame). Detections whose shorter bbox side is below this value are
   * dropped before persisting. `null`/missing → DEFAULT_FACE_MIN_DETECTION_SIZE. */
  face_min_detection_size?: number | null;
  /** Legacy field names — reader uses them as fallback for the new names;
   * writer never sets them. Kept on the type so DB rows written by the v1
   * face pipeline still round-trip cleanly. Operators upgrading should
   * drop these values via /settings/enrichment (v1 weights are
   * incompatible with the new alignment + recognizer pipeline). */
  face_retinaface_url?: string | null;
  face_retinaface_sha256?: string | null;
  face_mobilefacenet_url?: string | null;
  face_mobilefacenet_sha256?: string | null;
  // ── Search index (Phase 7) ───────────────────────────────────────────
  /** Meilisearch sidecar base URL for typo-tolerant search. `null`/missing →
   * falls back to `MAPLE_MEILISEARCH_URL` / unset (search uses the Mongo
   * `$text` path). */
  meilisearch_url?: string | null;
  /** Meilisearch API key (master/search key). Secret: persisted but never
   * echoed back over HTTP — the config route reports only whether a key is
   * set. `null`/missing → falls back to the `MAPLE_MEILISEARCH_API_KEY` env
   * var. */
  meilisearch_api_key?: string | null;
  updated_at?: number;
}

interface EnrichmentConfigDoc {
  _id: string;
  config: EnrichmentConfig;
}

/** Read the persisted config. Returns `null` when no row exists yet (first
 * boot of a fresh database). The caller should fall back to env vars. */
export async function loadEnrichmentConfig(): Promise<EnrichmentConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<EnrichmentConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** One-shot log gates for the legacy → new key remapping below — keyed by
 * the legacy field name so we warn at most once per key per process. */
const warnedLegacyWrites = new Set<string>();

/** Map of legacy field → canonical new field. When a patch supplies a
 * legacy key AND the new key is absent, the legacy value is copied onto
 * the new key before persistence (with a one-shot deprecation log). When
 * both are present, the new key wins. */
const LEGACY_FIELD_REMAP: ReadonlyArray<readonly [keyof EnrichmentConfig, keyof EnrichmentConfig]> =
  [
    ['face_retinaface_url', 'face_detector_url'],
    ['face_retinaface_sha256', 'face_detector_sha256'],
    ['face_mobilefacenet_url', 'face_recognizer_url'],
    ['face_mobilefacenet_sha256', 'face_recognizer_sha256'],
  ];

/** Upsert. Partial patches are supported: only the fields you supply are
 * touched, the rest of the config doc is preserved.
 *
 * Legacy field handling: if a patch supplies `face_retinaface_url` /
 * `face_mobilefacenet_url` (or the `_sha256` variants) AND the new key
 * is absent, we transparently map legacy → new before persisting. This
 * lets an operator UI that still POSTs the v1 key names land its value
 * under the new schema where the resolver can find it, instead of
 * silently dropping the write. When BOTH the legacy and new keys are
 * present in one patch, the new key wins. */
export async function saveEnrichmentConfig(patch: Partial<EnrichmentConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    'config.updated_at': Date.now(),
  };

  // Mutate `patch` to overlay legacy values onto the new keys when the
  // new key is absent. Done before the field-by-field $set build below
  // so a single saved value lands under one (canonical) field.
  const remapped: Partial<EnrichmentConfig> = { ...patch };
  for (const [legacy, current] of LEGACY_FIELD_REMAP) {
    if (remapped[current] === undefined && remapped[legacy] !== undefined) {
      (remapped as Record<string, unknown>)[current] = remapped[legacy];
      if (!warnedLegacyWrites.has(legacy)) {
        warnedLegacyWrites.add(legacy);
        log.warn(
          `saveEnrichmentConfig: mapping legacy \`${legacy}\` to \`${current}\` — update your client to use the new key.`,
        );
      }
    }
  }

  if (remapped.nominatim_url !== undefined) {
    set['config.nominatim_url'] = remapped.nominatim_url;
  }
  if (remapped.geocode_worker_enabled !== undefined) {
    set['config.geocode_worker_enabled'] = remapped.geocode_worker_enabled;
  }
  if (remapped.nominatim_rate_limit_per_sec !== undefined) {
    set['config.nominatim_rate_limit_per_sec'] = remapped.nominatim_rate_limit_per_sec;
  }
  if (remapped.describe_worker_enabled !== undefined) {
    set['config.describe_worker_enabled'] = remapped.describe_worker_enabled;
  }
  if (remapped.describe_provider !== undefined) {
    set['config.describe_provider'] = remapped.describe_provider;
  }
  if (remapped.describe_model !== undefined) {
    set['config.describe_model'] = remapped.describe_model;
  }
  if (remapped.describe_system_prompt !== undefined) {
    set['config.describe_system_prompt'] = remapped.describe_system_prompt;
  }
  if (remapped.describe_daily_cap_usd !== undefined) {
    set['config.describe_daily_cap_usd'] = remapped.describe_daily_cap_usd;
  }
  if (remapped.describe_provider_url !== undefined) {
    set['config.describe_provider_url'] = remapped.describe_provider_url;
  }
  if (remapped.face_worker_enabled !== undefined) {
    set['config.face_worker_enabled'] = remapped.face_worker_enabled;
  }
  if (remapped.face_model_dir !== undefined) {
    set['config.face_model_dir'] = remapped.face_model_dir;
  }
  if (remapped.face_detector_url !== undefined) {
    set['config.face_detector_url'] = remapped.face_detector_url;
  }
  if (remapped.face_detector_sha256 !== undefined) {
    set['config.face_detector_sha256'] = remapped.face_detector_sha256;
  }
  if (remapped.face_recognizer_url !== undefined) {
    set['config.face_recognizer_url'] = remapped.face_recognizer_url;
  }
  if (remapped.face_recognizer_sha256 !== undefined) {
    set['config.face_recognizer_sha256'] = remapped.face_recognizer_sha256;
  }
  if (remapped.face_min_detection_size !== undefined) {
    set['config.face_min_detection_size'] = remapped.face_min_detection_size;
  }
  if (remapped.meilisearch_url !== undefined) {
    set['config.meilisearch_url'] = remapped.meilisearch_url;
  }
  if (remapped.meilisearch_api_key !== undefined) {
    set['config.meilisearch_api_key'] = remapped.meilisearch_api_key;
  }
  await db.collection(COLL).updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

// The pure resolver (`ResolvedEnrichmentConfig` + `resolveEnrichmentConfig`)
// lives in the sibling `enrichment-config.resolve.ts` module to keep this file
// under the file-size budget. Re-exported here so existing importers that pull
// these from `enrichment-config.repo.ts` keep working unchanged.
export {
  resolveEnrichmentConfig,
  type ResolvedEnrichmentConfig,
} from './enrichment-config.resolve.ts';
