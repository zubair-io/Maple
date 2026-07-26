/**
 * Pure resolver for the enrichment runtime config. Split out of
 * `enrichment-config.repo.ts` (which owns load/save + the shared types and
 * constants) to keep each file under the file-size budget.
 *
 * `resolveEnrichmentConfig` takes the persisted DB row (or `null`) plus the
 * process env and computes the effective config with per-field provenance:
 * DB row wins, then env var, then a built-in default. It is a pure function —
 * no side effects, no I/O — so it is trivial to unit-test.
 *
 * Importers historically pull `ResolvedEnrichmentConfig` /
 * `resolveEnrichmentConfig` from `enrichment-config.repo.ts`; that file
 * re-exports both from here so those import paths keep working unchanged.
 */

import type { DescribeProviderName } from './describe-providers/index.ts';
import { parseWhisperTier, type WhisperTier } from '../audio/whisper-model.ts';
import { validMeilisearchSemanticRatio } from './meilisearch-config.ts';
import {
  DEFAULT_DESCRIBE_DAILY_CAP_USD,
  DEFAULT_DESCRIBE_MODELS,
  DEFAULT_DESCRIBE_OLLAMA_URL,
  DEFAULT_DESCRIBE_PROVIDER,
  DEFAULT_DESCRIBE_SYSTEM_PROMPT,
  DEFAULT_FACE_MIN_DETECTION_SIZE,
  DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  DEFAULT_MEILISEARCH_SEMANTIC_ENABLED,
  DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
  DEFAULT_MEILISEARCH_TASK_TIMEOUT_SECONDS,
  DEFAULT_NOMINATIM_RATE_LIMIT_PER_SEC,
  DEFAULT_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE,
  MAX_MEILISEARCH_TASK_TIMEOUT_SECONDS,
  MAX_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE,
  MIN_MEILISEARCH_TASK_TIMEOUT_SECONDS,
  MIN_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE,
  MAX_FACE_MIN_DETECTION_SIZE,
  MIN_FACE_MIN_DETECTION_SIZE,
  asDescribeProvider,
  builtinModelDir,
  type EnrichmentConfig,
} from './enrichment-config.repo.ts';

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
  /** Shared Ollama URL used by Describe and semantic search. The selected
   * Describe provider does not discard it. */
  describe_provider_url: string;
  /** Resolved model id. Always populated — falls back to the provider's
   * built-in default. */
  describe_model: string;
  describe_system_prompt: string;
  describe_daily_cap_usd: number;
  transcribe_model_tier: WhisperTier;
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
   * value (normalised [0, 1) on the 640-px detection frame). */
  face_min_detection_size: number;
  /** Resolved Meilisearch sidecar URL (DB → env → null). `null` leaves the
   * sidecar disabled and search falls back to the Mongo `$text` path. */
  meilisearch_url: string | null;
  /** Resolved Meilisearch API key (DB → env → null). Secret: the config
   * route strips this before responding — never send it to a client. */
  meilisearch_api_key: string | null;
  meilisearch_task_timeout_seconds: number;
  meilisearch_semantic_enabled: boolean;
  meilisearch_embedder_url: string;
  meilisearch_embedder_model: string;
  meilisearch_semantic_ratio: number;
  service_search_rate_limit_per_minute: number;
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
    transcribe_model_tier: 'db' | 'default';
    face_worker_enabled: 'db' | 'env' | 'default';
    face_model_dir: 'db' | 'env' | 'default';
    face_detector_url: 'db' | 'env' | 'unset';
    face_detector_sha256: 'db' | 'env' | 'unset';
    face_recognizer_url: 'db' | 'env' | 'unset';
    face_recognizer_sha256: 'db' | 'env' | 'unset';
    face_min_detection_size: 'db' | 'default';
    meilisearch_url: 'db' | 'env' | 'unset';
    meilisearch_api_key: 'db' | 'env' | 'unset';
    meilisearch_task_timeout_seconds: 'db' | 'default';
    meilisearch_semantic_enabled: 'db' | 'default';
    meilisearch_embedder_url: 'db' | 'env' | 'default';
    meilisearch_embedder_model: 'db' | 'default';
    meilisearch_semantic_ratio: 'db' | 'default';
    service_search_rate_limit_per_minute: 'db' | 'default';
  };
}

function resolveMeilisearchTaskTimeout(db: EnrichmentConfig | null): {
  value: number;
  source: 'db' | 'default';
} {
  const saved = db?.meilisearch_task_timeout_seconds;
  const valid =
    typeof saved === 'number' &&
    Number.isInteger(saved) &&
    saved >= MIN_MEILISEARCH_TASK_TIMEOUT_SECONDS &&
    saved <= MAX_MEILISEARCH_TASK_TIMEOUT_SECONDS;
  return valid
    ? { value: saved, source: 'db' }
    : { value: DEFAULT_MEILISEARCH_TASK_TIMEOUT_SECONDS, source: 'default' };
}

function resolveServiceSearchRateLimit(db: EnrichmentConfig | null): {
  value: number;
  source: 'db' | 'default';
} {
  const saved = db?.service_search_rate_limit_per_minute;
  const valid =
    typeof saved === 'number' &&
    Number.isFinite(saved) &&
    saved >= MIN_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE &&
    saved <= MAX_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE;
  return valid
    ? { value: Math.trunc(saved), source: 'db' }
    : { value: DEFAULT_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE, source: 'default' };
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

  // Keep the shared Ollama endpoint resolved even when a non-Ollama Describe
  // provider is selected. Semantic search still needs it, and provider
  // switches must not make the saved endpoint disappear from Settings.
  let describeUrl = DEFAULT_DESCRIBE_OLLAMA_URL;
  let describeUrlSource: ResolvedEnrichmentConfig['source']['describe_provider_url'] = 'default';
  const savedDescribeUrl = db?.describe_provider_url?.trim();
  const envDescribeUrl = env.MAPLE_DESCRIBE_PROVIDER_URL?.trim();
  if (savedDescribeUrl) {
    describeUrl = savedDescribeUrl;
    describeUrlSource = 'db';
  } else if (envDescribeUrl) {
    describeUrl = envDescribeUrl;
    describeUrlSource = 'env';
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

  const transcribeTier = parseWhisperTier(db?.transcribe_model_tier);
  const transcribeTierSource: 'db' | 'default' =
    db?.transcribe_model_tier === transcribeTier ? 'db' : 'default';

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
  const meilisearchSemanticEnabled =
    typeof db?.meilisearch_semantic_enabled === 'boolean'
      ? { value: db.meilisearch_semantic_enabled, source: 'db' as const }
      : { value: DEFAULT_MEILISEARCH_SEMANTIC_ENABLED, source: 'default' as const };
  // Meilisearch calls Ollama directly, but Maple owns both configurations.
  // Reuse Describe's resolved Ollama endpoint so a container/remote hostname
  // cannot silently drift between captioning and semantic search.
  const meilisearchEmbedderUrl = {
    value: describeUrl,
    source:
      describeUrlSource === 'db' || describeUrlSource === 'env'
        ? describeUrlSource
        : ('default' as const),
  };
  const savedEmbedderModel = db?.meilisearch_embedder_model?.trim();
  const meilisearchEmbedderModel =
    savedEmbedderModel && savedEmbedderModel.length > 0
      ? { value: savedEmbedderModel, source: 'db' as const }
      : { value: DEFAULT_MEILISEARCH_EMBEDDER_MODEL, source: 'default' as const };
  const savedSemanticRatio = db?.meilisearch_semantic_ratio;
  const meilisearchSemanticRatio = validMeilisearchSemanticRatio(savedSemanticRatio)
    ? { value: savedSemanticRatio, source: 'db' as const }
    : { value: DEFAULT_MEILISEARCH_SEMANTIC_RATIO, source: 'default' as const };

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

  const serviceSearchRateLimit = resolveServiceSearchRateLimit(db);
  const meilisearchTaskTimeout = resolveMeilisearchTaskTimeout(db);

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
    transcribe_model_tier: transcribeTier,
    face_worker_enabled: faceEnabled,
    face_model_dir: faceModelDir,
    face_detector_url: faceDetectorUrl.value,
    face_detector_sha256: faceDetectorSha.value,
    face_recognizer_url: faceRecognizerUrl.value,
    face_recognizer_sha256: faceRecognizerSha.value,
    face_min_detection_size: faceMinDetectionSize,
    meilisearch_url: meilisearchUrl.value,
    meilisearch_api_key: meilisearchApiKey.value,
    meilisearch_task_timeout_seconds: meilisearchTaskTimeout.value,
    meilisearch_semantic_enabled: meilisearchSemanticEnabled.value,
    meilisearch_embedder_url: meilisearchEmbedderUrl.value,
    meilisearch_embedder_model: meilisearchEmbedderModel.value,
    meilisearch_semantic_ratio: meilisearchSemanticRatio.value,
    service_search_rate_limit_per_minute: serviceSearchRateLimit.value,
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
      transcribe_model_tier: transcribeTierSource,
      face_worker_enabled: faceEnabledSource,
      face_model_dir: faceModelDirSource,
      face_detector_url: faceDetectorUrl.source,
      face_detector_sha256: faceDetectorSha.source,
      face_recognizer_url: faceRecognizerUrl.source,
      face_recognizer_sha256: faceRecognizerSha.source,
      face_min_detection_size: faceMinDetectionSizeSource,
      meilisearch_url: meilisearchUrl.source,
      meilisearch_api_key: meilisearchApiKey.source,
      meilisearch_task_timeout_seconds: meilisearchTaskTimeout.source,
      meilisearch_semantic_enabled: meilisearchSemanticEnabled.source,
      meilisearch_embedder_url: meilisearchEmbedderUrl.source,
      meilisearch_embedder_model: meilisearchEmbedderModel.source,
      meilisearch_semantic_ratio: meilisearchSemanticRatio.source,
      service_search_rate_limit_per_minute: serviceSearchRateLimit.source,
    },
  };
}
