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
 * agree without a circular import. */
function builtinModelDir(): string {
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
 * Ollama library tag for the locked vision model. The hyphen between "5"
 * and "vl" is intentionally absent — that matches Ollama's published name
 * (`ollama pull qwen2.5vl:7b`). Earlier code used the HuggingFace form
 * `qwen2.5-vl:7b`, which Ollama 404s on. Single source of truth so the
 * stage handler, the bootstrap health check, and the UI copy can't drift.
 *
 * `ocr_meta.engine` (a Maple-internal discriminator) is unrelated and stays
 * `"qwen2.5-vl"` — changing that would invalidate every existing DB row.
 */
export const QWEN_VL_OLLAMA_TAG = 'qwen2.5vl:7b';

export const DEFAULT_DESCRIBE_MODELS: Record<DescribeProviderName, string> = {
  // Default to the Ollama qwen2.5-VL 7B tag. Produces structured JSON
  // matching DEFAULT_DESCRIBE_VISION_PROMPT below. The previous
  // "llava:latest" default produced free-text captions incompatible with
  // the parser, and the earlier `qwen2.5-vl:7b` form was a 404 on Ollama.
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
  /** Minimum face size filter (normalised [0, 1] on the 640-px detection
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

/**
 * Resolve the effective config: DB row wins; missing fields fall back to env
 * vars; missing env vars fall back to defaults (no URL → worker dormant;
 * enabled defaults true). Pure function — no side effects, easy to test.
 */
export interface ResolvedEnrichmentConfig {
  nominatim_url: string | null;
  geocode_worker_enabled: boolean;
  nominatim_rate_limit_per_sec: number;
  // ── Describe worker (Phase 6) ────────────────────────────────────────
  describe_worker_enabled: boolean;
  describe_provider: DescribeProviderName;
  /** Resolved provider URL. For Ollama defaults to `http://localhost:11434`;
   * for paid providers this is `null` (their endpoints are hard-coded). */
  describe_provider_url: string | null;
  /** Resolved model id. Always populated — falls back to the provider's
   * built-in default. */
  describe_model: string;
  describe_system_prompt: string;
  describe_daily_cap_usd: number;
  /** Phase 5 face worker. Resolved from DB → env → built-in default false. */
  face_worker_enabled: boolean;
  /** Resolved model dir (DB → env → default `~/.maple/models/`). Always
   * populated. The face worker stages model files here. */
  face_model_dir: string;
  /** Resolved face-detector (SCRFD-10G) download URL — `null` when neither
   * DB nor env supplied one. The worker requires the file to be already
   * on disk (under face_model_dir/scrfd_10g.onnx) when this is null. */
  face_detector_url: string | null;
  face_detector_sha256: string | null;
  /** Resolved face-recognizer (ArcFace R100) download URL. */
  face_recognizer_url: string | null;
  face_recognizer_sha256: string | null;
  /** Resolved minimum face-size threshold (DB → default). Always a number.
   * The face-detect stage drops any bbox whose shorter side is below this
   * value (normalised [0, 1] on the 640-px detection frame). */
  face_min_detection_size: number;
  /** Resolved Meilisearch sidecar URL (DB → env → null). `null` leaves the
   * sidecar disabled and search falls back to the Mongo `$text` path. */
  meilisearch_url: string | null;
  /** Resolved Meilisearch API key (DB → env → null). Secret: the config
   * route strips this before responding — never send it to a client. */
  meilisearch_api_key: string | null;
  /** Where each field came from. The UI renders this so the operator knows
   * whether they're seeing a saved value or an env-var fallback. */
  source: {
    nominatim_url: 'db' | 'env' | 'unset';
    geocode_worker_enabled: 'db' | 'env' | 'default';
    nominatim_rate_limit_per_sec: 'db' | 'env' | 'default';
    describe_worker_enabled: 'db' | 'env' | 'default';
    describe_provider: 'db' | 'env' | 'default';
    describe_provider_url: 'db' | 'env' | 'default' | 'unset';
    describe_model: 'db' | 'env' | 'default';
    describe_system_prompt: 'db' | 'env' | 'default';
    describe_daily_cap_usd: 'db' | 'env' | 'default';
    face_worker_enabled: 'db' | 'env' | 'default';
    face_model_dir: 'db' | 'env' | 'default';
    face_detector_url: 'db' | 'env' | 'unset';
    face_detector_sha256: 'db' | 'env' | 'unset';
    face_recognizer_url: 'db' | 'env' | 'unset';
    face_recognizer_sha256: 'db' | 'env' | 'unset';
    face_min_detection_size: 'db' | 'default';
    meilisearch_url: 'db' | 'env' | 'unset';
    meilisearch_api_key: 'db' | 'env' | 'unset';
  };
}

export function resolveEnrichmentConfig(
  db: EnrichmentConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnrichmentConfig {
  let url: string | null = null;
  let urlSource: ResolvedEnrichmentConfig['source']['nominatim_url'] = 'unset';
  if (db && db.nominatim_url !== null && db.nominatim_url !== undefined) {
    url = db.nominatim_url;
    urlSource = 'db';
  } else if (env.MAPLE_NOMINATIM_URL && env.MAPLE_NOMINATIM_URL.length > 0) {
    url = env.MAPLE_NOMINATIM_URL;
    urlSource = 'env';
  }

  let enabled = true;
  let enabledSource: ResolvedEnrichmentConfig['source']['geocode_worker_enabled'] = 'default';
  if (db && typeof db.geocode_worker_enabled === 'boolean') {
    enabled = db.geocode_worker_enabled;
    enabledSource = 'db';
  } else if (env.MAPLE_GEOCODE_WORKER_ENABLED !== undefined) {
    enabled = env.MAPLE_GEOCODE_WORKER_ENABLED !== 'false';
    enabledSource = 'env';
  }

  let rateLimit = DEFAULT_NOMINATIM_RATE_LIMIT_PER_SEC;
  let rateSource: ResolvedEnrichmentConfig['source']['nominatim_rate_limit_per_sec'] = 'default';
  if (
    db &&
    typeof db.nominatim_rate_limit_per_sec === 'number' &&
    Number.isFinite(db.nominatim_rate_limit_per_sec) &&
    db.nominatim_rate_limit_per_sec > 0
  ) {
    rateLimit = db.nominatim_rate_limit_per_sec;
    rateSource = 'db';
  } else if (env.MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC) {
    const parsed = Number(env.MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC);
    if (Number.isFinite(parsed) && parsed > 0) {
      rateLimit = parsed;
      rateSource = 'env';
    }
  }

  // ── Describe worker (Phase 6) ────────────────────────────────────────
  // Each field follows the same precedence: DB row > env var > built-in
  // default. Shape mirrors the geocode block above so adding a fourth
  // worker is mechanical.

  let describeEnabled = true;
  let describeEnabledSource: ResolvedEnrichmentConfig['source']['describe_worker_enabled'] =
    'default';
  if (db && typeof db.describe_worker_enabled === 'boolean') {
    describeEnabled = db.describe_worker_enabled;
    describeEnabledSource = 'db';
  } else if (env.MAPLE_DESCRIBE_WORKER_ENABLED !== undefined) {
    describeEnabled = env.MAPLE_DESCRIBE_WORKER_ENABLED !== 'false';
    describeEnabledSource = 'env';
  }

  let describeProvider: DescribeProviderName = DEFAULT_DESCRIBE_PROVIDER;
  let describeProviderSource: ResolvedEnrichmentConfig['source']['describe_provider'] = 'default';
  if (db && db.describe_provider !== null && db.describe_provider !== undefined) {
    const validated = asDescribeProvider(db.describe_provider);
    if (validated) {
      describeProvider = validated;
      describeProviderSource = 'db';
    }
  } else if (env.MAPLE_DESCRIBE_PROVIDER) {
    const validated = asDescribeProvider(env.MAPLE_DESCRIBE_PROVIDER);
    if (validated) {
      describeProvider = validated;
      describeProviderSource = 'env';
    }
  }

  // Provider URL is meaningful for Ollama only; for paid providers the
  // resolved value is `null` and the field is hidden from the UI. We still
  // honour env / DB for the Ollama case so a saved value persists across
  // provider switches (re-selecting Ollama recovers the URL).
  let describeUrl: string | null = null;
  let describeUrlSource: ResolvedEnrichmentConfig['source']['describe_provider_url'] = 'unset';
  if (describeProvider === 'ollama') {
    if (db && db.describe_provider_url !== null && db.describe_provider_url !== undefined) {
      describeUrl = db.describe_provider_url;
      describeUrlSource = 'db';
    } else if (env.MAPLE_DESCRIBE_PROVIDER_URL && env.MAPLE_DESCRIBE_PROVIDER_URL.length > 0) {
      describeUrl = env.MAPLE_DESCRIBE_PROVIDER_URL;
      describeUrlSource = 'env';
    } else {
      describeUrl = DEFAULT_DESCRIBE_OLLAMA_URL;
      describeUrlSource = 'default';
    }
  }

  let describeModel = DEFAULT_DESCRIBE_MODELS[describeProvider];
  let describeModelSource: ResolvedEnrichmentConfig['source']['describe_model'] = 'default';
  if (db && typeof db.describe_model === 'string' && db.describe_model.length > 0) {
    describeModel = db.describe_model;
    describeModelSource = 'db';
  } else if (env.MAPLE_DESCRIBE_MODEL && env.MAPLE_DESCRIBE_MODEL.length > 0) {
    describeModel = env.MAPLE_DESCRIBE_MODEL;
    describeModelSource = 'env';
  }

  let describePrompt = DEFAULT_DESCRIBE_SYSTEM_PROMPT;
  let describePromptSource: ResolvedEnrichmentConfig['source']['describe_system_prompt'] =
    'default';
  if (db && typeof db.describe_system_prompt === 'string' && db.describe_system_prompt.length > 0) {
    describePrompt = db.describe_system_prompt;
    describePromptSource = 'db';
  } else if (env.MAPLE_DESCRIBE_SYSTEM_PROMPT && env.MAPLE_DESCRIBE_SYSTEM_PROMPT.length > 0) {
    describePrompt = env.MAPLE_DESCRIBE_SYSTEM_PROMPT;
    describePromptSource = 'env';
  }

  let describeCap = DEFAULT_DESCRIBE_DAILY_CAP_USD;
  let describeCapSource: ResolvedEnrichmentConfig['source']['describe_daily_cap_usd'] = 'default';
  if (
    db &&
    typeof db.describe_daily_cap_usd === 'number' &&
    Number.isFinite(db.describe_daily_cap_usd) &&
    db.describe_daily_cap_usd > 0
  ) {
    describeCap = db.describe_daily_cap_usd;
    describeCapSource = 'db';
  } else if (env.MAPLE_DESCRIBE_DAILY_CAP_USD) {
    const parsed = Number(env.MAPLE_DESCRIBE_DAILY_CAP_USD);
    if (Number.isFinite(parsed) && parsed > 0) {
      describeCap = parsed;
      describeCapSource = 'env';
    }
  }

  // ── Face worker (Phase 5) ────────────────────────────────────────────
  let faceEnabled = false;
  let faceEnabledSource: ResolvedEnrichmentConfig['source']['face_worker_enabled'] = 'default';
  if (db && typeof db.face_worker_enabled === 'boolean') {
    faceEnabled = db.face_worker_enabled;
    faceEnabledSource = 'db';
  } else if (env.MAPLE_FACE_WORKER_ENABLED !== undefined) {
    faceEnabled = env.MAPLE_FACE_WORKER_ENABLED === 'true';
    faceEnabledSource = 'env';
  }

  // Helper for the four "DB → env → unset" face-model URL/SHA fields.
  // Trims and rejects empty strings so a cleared input doesn't masquerade
  // as a saved value.
  function resolveStr(
    dbVal: string | null | undefined,
    envVal: string | undefined,
  ): { value: string | null; source: 'db' | 'env' | 'unset' } {
    if (typeof dbVal === 'string' && dbVal.trim().length > 0) {
      return { value: dbVal.trim(), source: 'db' };
    }
    if (typeof envVal === 'string' && envVal.trim().length > 0) {
      return { value: envVal.trim(), source: 'env' };
    }
    return { value: null, source: 'unset' };
  }

  let faceModelDir = builtinModelDir();
  let faceModelDirSource: ResolvedEnrichmentConfig['source']['face_model_dir'] = 'default';
  if (db && typeof db.face_model_dir === 'string' && db.face_model_dir.trim().length > 0) {
    faceModelDir = db.face_model_dir.trim();
    faceModelDirSource = 'db';
  } else if (env.MAPLE_MODEL_DIR && env.MAPLE_MODEL_DIR.length > 0) {
    faceModelDir = env.MAPLE_MODEL_DIR;
    faceModelDirSource = 'env';
  }

  // Read new field names first, fall back to legacy `face_retinaface_*` /
  // `face_mobilefacenet_*` so DB rows + env vars from the v1 face pipeline
  // still expose their (now-deprecated) value. The face-models loader
  // emits a one-shot warn() on the legacy env path.
  const faceDetectorUrl = resolveStr(
    db?.face_detector_url ?? db?.face_retinaface_url,
    env.MAPLE_FACE_DETECTOR_URL ?? env.MAPLE_FACE_RETINAFACE_URL,
  );
  const faceDetectorSha = resolveStr(
    db?.face_detector_sha256 ?? db?.face_retinaface_sha256,
    env.MAPLE_FACE_DETECTOR_SHA256 ?? env.MAPLE_FACE_RETINAFACE_SHA256,
  );
  const faceRecognizerUrl = resolveStr(
    db?.face_recognizer_url ?? db?.face_mobilefacenet_url,
    env.MAPLE_FACE_RECOGNIZER_URL ?? env.MAPLE_FACE_MOBILEFACENET_URL,
  );
  const faceRecognizerSha = resolveStr(
    db?.face_recognizer_sha256 ?? db?.face_mobilefacenet_sha256,
    env.MAPLE_FACE_RECOGNIZER_SHA256 ?? env.MAPLE_FACE_MOBILEFACENET_SHA256,
  );

  // Meilisearch sidecar — URL + API key, each DB → env → null.
  const meilisearchUrl = resolveStr(db?.meilisearch_url, env.MAPLE_MEILISEARCH_URL);
  const meilisearchApiKey = resolveStr(db?.meilisearch_api_key, env.MAPLE_MEILISEARCH_API_KEY);

  // Minimum face size — DB-only (no env var); falls back to built-in default.
  let faceMinDetectionSize = DEFAULT_FACE_MIN_DETECTION_SIZE;
  let faceMinDetectionSizeSource: ResolvedEnrichmentConfig['source']['face_min_detection_size'] =
    'default';
  if (
    db &&
    typeof db.face_min_detection_size === 'number' &&
    Number.isFinite(db.face_min_detection_size) &&
    db.face_min_detection_size >= MIN_FACE_MIN_DETECTION_SIZE &&
    db.face_min_detection_size < MAX_FACE_MIN_DETECTION_SIZE
  ) {
    faceMinDetectionSize = db.face_min_detection_size;
    faceMinDetectionSizeSource = 'db';
  }

  return {
    nominatim_url: url,
    geocode_worker_enabled: enabled,
    nominatim_rate_limit_per_sec: rateLimit,
    describe_worker_enabled: describeEnabled,
    describe_provider: describeProvider,
    describe_provider_url: describeUrl,
    describe_model: describeModel,
    describe_system_prompt: describePrompt,
    describe_daily_cap_usd: describeCap,
    face_worker_enabled: faceEnabled,
    face_model_dir: faceModelDir,
    face_detector_url: faceDetectorUrl.value,
    face_detector_sha256: faceDetectorSha.value,
    face_recognizer_url: faceRecognizerUrl.value,
    face_recognizer_sha256: faceRecognizerSha.value,
    face_min_detection_size: faceMinDetectionSize,
    meilisearch_url: meilisearchUrl.value,
    meilisearch_api_key: meilisearchApiKey.value,
    source: {
      nominatim_url: urlSource,
      geocode_worker_enabled: enabledSource,
      nominatim_rate_limit_per_sec: rateSource,
      describe_worker_enabled: describeEnabledSource,
      describe_provider: describeProviderSource,
      describe_provider_url: describeUrlSource,
      describe_model: describeModelSource,
      describe_system_prompt: describePromptSource,
      describe_daily_cap_usd: describeCapSource,
      face_worker_enabled: faceEnabledSource,
      face_model_dir: faceModelDirSource,
      face_detector_url: faceDetectorUrl.source,
      face_detector_sha256: faceDetectorSha.source,
      face_recognizer_url: faceRecognizerUrl.source,
      face_recognizer_sha256: faceRecognizerSha.source,
      face_min_detection_size: faceMinDetectionSizeSource,
      meilisearch_url: meilisearchUrl.source,
      meilisearch_api_key: meilisearchApiKey.source,
    },
  };
}
