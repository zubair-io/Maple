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

import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../db/client.ts";
import type { DescribeProviderName } from "./describe-providers/index.ts";

const COLL = "app_settings";
const DOC_ID = "enrichment";

/** Default model directory used by the face worker. Mirrors
 * `face-models.ts:defaultModelDir()` so the resolver and the worker
 * agree without a circular import. */
function builtinModelDir(): string {
  return join(homedir(), ".maple", "models");
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

/** Defaults for the describe worker. The local Ollama default keeps Maple's
 * Self Hosted deploy working out of the box without an API key. */
export const DEFAULT_DESCRIBE_PROVIDER: DescribeProviderName = "ollama";
export const DEFAULT_DESCRIBE_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_DESCRIBE_MODELS: Record<DescribeProviderName, string> = {
  ollama: "llava:latest",
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  gemini: "gemini-flash",
};
export const DEFAULT_DESCRIBE_SYSTEM_PROMPT =
  "Describe this photo in one or two concise English sentences. " +
  "Focus on the subject, scene and notable visual details. " +
  "Avoid speculation about identity or location.";
/** Daily USD spend cap for paid providers. The worker pauses (returns
 * `circuit-pause`) for the rest of the UTC day once the cap is hit. */
export const DEFAULT_DESCRIBE_DAILY_CAP_USD = 5;
/** Reject obviously broken cap values. Zero would silently pause the
 * worker forever; >1000 USD/day on a single deploy is almost certainly a
 * misclick (and the resulting damage rolls fast on a paid provider). */
export const MIN_DESCRIBE_DAILY_CAP_USD = 0;
export const MAX_DESCRIBE_DAILY_CAP_USD = 1000;

const ALL_PROVIDERS: ReadonlyArray<DescribeProviderName> = [
  "ollama",
  "anthropic",
  "openai",
  "gemini",
];

/** Validate a provider string. Returns the typed name or `null` if
 * unrecognised; the route uses this to reject bad PUT bodies. */
export function asDescribeProvider(
  raw: unknown,
): DescribeProviderName | null {
  if (typeof raw !== "string") return null;
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
   * RetinaFace + MobileFaceNet ONNX model files on disk (or downloadable
   * from operator-supplied URLs). `null` falls through to env / default. */
  face_worker_enabled?: boolean | null;
  /** Override for the model directory. `null` falls through to
   * `MAPLE_MODEL_DIR` / `~/.maple/models/`. */
  face_model_dir?: string | null;
  /** Operator-supplied download URL for `retinaface.onnx`. Used when the
   * file isn't already on disk under `<face_model_dir>/retinaface.onnx`. */
  face_retinaface_url?: string | null;
  /** Optional SHA256 (hex) verification for the downloaded RetinaFace
   * blob. Skipped when null. */
  face_retinaface_sha256?: string | null;
  face_mobilefacenet_url?: string | null;
  face_mobilefacenet_sha256?: string | null;
  // ── OCR worker (Phase 8) ─────────────────────────────────────────────
  /** OCR worker enable flag. `null` means "operator hasn't touched it" —
   * resolver falls back to env / default (off). */
  ocr_worker_enabled?: boolean | null;
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
    const doc = await db
      .collection<EnrichmentConfigDoc>(COLL)
      .findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only the fields you supply are
 * touched, the rest of the config doc is preserved. */
export async function saveEnrichmentConfig(
  patch: Partial<EnrichmentConfig>,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    "config.updated_at": Date.now(),
  };
  if (patch.nominatim_url !== undefined) {
    set["config.nominatim_url"] = patch.nominatim_url;
  }
  if (patch.geocode_worker_enabled !== undefined) {
    set["config.geocode_worker_enabled"] = patch.geocode_worker_enabled;
  }
  if (patch.nominatim_rate_limit_per_sec !== undefined) {
    set["config.nominatim_rate_limit_per_sec"] =
      patch.nominatim_rate_limit_per_sec;
  }
  if (patch.describe_worker_enabled !== undefined) {
    set["config.describe_worker_enabled"] = patch.describe_worker_enabled;
  }
  if (patch.describe_provider !== undefined) {
    set["config.describe_provider"] = patch.describe_provider;
  }
  if (patch.describe_model !== undefined) {
    set["config.describe_model"] = patch.describe_model;
  }
  if (patch.describe_system_prompt !== undefined) {
    set["config.describe_system_prompt"] = patch.describe_system_prompt;
  }
  if (patch.describe_daily_cap_usd !== undefined) {
    set["config.describe_daily_cap_usd"] = patch.describe_daily_cap_usd;
  }
  if (patch.describe_provider_url !== undefined) {
    set["config.describe_provider_url"] = patch.describe_provider_url;
  }
  if (patch.face_worker_enabled !== undefined) {
    set["config.face_worker_enabled"] = patch.face_worker_enabled;
  }
  if (patch.face_model_dir !== undefined) {
    set["config.face_model_dir"] = patch.face_model_dir;
  }
  if (patch.face_retinaface_url !== undefined) {
    set["config.face_retinaface_url"] = patch.face_retinaface_url;
  }
  if (patch.face_retinaface_sha256 !== undefined) {
    set["config.face_retinaface_sha256"] = patch.face_retinaface_sha256;
  }
  if (patch.face_mobilefacenet_url !== undefined) {
    set["config.face_mobilefacenet_url"] = patch.face_mobilefacenet_url;
  }
  if (patch.face_mobilefacenet_sha256 !== undefined) {
    set["config.face_mobilefacenet_sha256"] = patch.face_mobilefacenet_sha256;
  }
  if (patch.ocr_worker_enabled !== undefined) {
    set["config.ocr_worker_enabled"] = patch.ocr_worker_enabled;
  }
  await db
    .collection(COLL)
    .updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
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
  /** Resolved RetinaFace download URL — `null` when neither DB nor env
   * supplied one. The worker requires the file to be already on disk
   * (under face_model_dir/retinaface.onnx) when this is null. */
  face_retinaface_url: string | null;
  face_retinaface_sha256: string | null;
  face_mobilefacenet_url: string | null;
  face_mobilefacenet_sha256: string | null;
  /** Phase 8 OCR worker. Resolved from DB → env → built-in default false. */
  ocr_worker_enabled: boolean;
  /** Where each field came from. The UI renders this so the operator knows
   * whether they're seeing a saved value or an env-var fallback. */
  source: {
    nominatim_url: "db" | "env" | "unset";
    geocode_worker_enabled: "db" | "env" | "default";
    nominatim_rate_limit_per_sec: "db" | "env" | "default";
    describe_worker_enabled: "db" | "env" | "default";
    describe_provider: "db" | "env" | "default";
    describe_provider_url: "db" | "env" | "default" | "unset";
    describe_model: "db" | "env" | "default";
    describe_system_prompt: "db" | "env" | "default";
    describe_daily_cap_usd: "db" | "env" | "default";
    face_worker_enabled: "db" | "env" | "default";
    face_model_dir: "db" | "env" | "default";
    face_retinaface_url: "db" | "env" | "unset";
    face_retinaface_sha256: "db" | "env" | "unset";
    face_mobilefacenet_url: "db" | "env" | "unset";
    face_mobilefacenet_sha256: "db" | "env" | "unset";
    ocr_worker_enabled: "db" | "env" | "default";
  };
}

export function resolveEnrichmentConfig(
  db: EnrichmentConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEnrichmentConfig {
  let url: string | null = null;
  let urlSource: ResolvedEnrichmentConfig["source"]["nominatim_url"] = "unset";
  if (db && db.nominatim_url !== null && db.nominatim_url !== undefined) {
    url = db.nominatim_url;
    urlSource = "db";
  } else if (env.MAPLE_NOMINATIM_URL && env.MAPLE_NOMINATIM_URL.length > 0) {
    url = env.MAPLE_NOMINATIM_URL;
    urlSource = "env";
  }

  let enabled = true;
  let enabledSource: ResolvedEnrichmentConfig["source"]["geocode_worker_enabled"] =
    "default";
  if (db && typeof db.geocode_worker_enabled === "boolean") {
    enabled = db.geocode_worker_enabled;
    enabledSource = "db";
  } else if (env.MAPLE_GEOCODE_WORKER_ENABLED !== undefined) {
    enabled = env.MAPLE_GEOCODE_WORKER_ENABLED !== "false";
    enabledSource = "env";
  }

  let rateLimit = DEFAULT_NOMINATIM_RATE_LIMIT_PER_SEC;
  let rateSource: ResolvedEnrichmentConfig["source"]["nominatim_rate_limit_per_sec"] =
    "default";
  if (
    db &&
    typeof db.nominatim_rate_limit_per_sec === "number" &&
    Number.isFinite(db.nominatim_rate_limit_per_sec) &&
    db.nominatim_rate_limit_per_sec > 0
  ) {
    rateLimit = db.nominatim_rate_limit_per_sec;
    rateSource = "db";
  } else if (env.MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC) {
    const parsed = Number(env.MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC);
    if (Number.isFinite(parsed) && parsed > 0) {
      rateLimit = parsed;
      rateSource = "env";
    }
  }

  // ── Describe worker (Phase 6) ────────────────────────────────────────
  // Each field follows the same precedence: DB row > env var > built-in
  // default. Shape mirrors the geocode block above so adding a fourth
  // worker is mechanical.

  let describeEnabled = true;
  let describeEnabledSource: ResolvedEnrichmentConfig["source"]["describe_worker_enabled"] =
    "default";
  if (db && typeof db.describe_worker_enabled === "boolean") {
    describeEnabled = db.describe_worker_enabled;
    describeEnabledSource = "db";
  } else if (env.MAPLE_DESCRIBE_WORKER_ENABLED !== undefined) {
    describeEnabled = env.MAPLE_DESCRIBE_WORKER_ENABLED !== "false";
    describeEnabledSource = "env";
  }

  let describeProvider: DescribeProviderName = DEFAULT_DESCRIBE_PROVIDER;
  let describeProviderSource: ResolvedEnrichmentConfig["source"]["describe_provider"] =
    "default";
  if (db && db.describe_provider !== null && db.describe_provider !== undefined) {
    const validated = asDescribeProvider(db.describe_provider);
    if (validated) {
      describeProvider = validated;
      describeProviderSource = "db";
    }
  } else if (env.MAPLE_DESCRIBE_PROVIDER) {
    const validated = asDescribeProvider(env.MAPLE_DESCRIBE_PROVIDER);
    if (validated) {
      describeProvider = validated;
      describeProviderSource = "env";
    }
  }

  // Provider URL is meaningful for Ollama only; for paid providers the
  // resolved value is `null` and the field is hidden from the UI. We still
  // honour env / DB for the Ollama case so a saved value persists across
  // provider switches (re-selecting Ollama recovers the URL).
  let describeUrl: string | null = null;
  let describeUrlSource: ResolvedEnrichmentConfig["source"]["describe_provider_url"] =
    "unset";
  if (describeProvider === "ollama") {
    if (
      db &&
      db.describe_provider_url !== null &&
      db.describe_provider_url !== undefined
    ) {
      describeUrl = db.describe_provider_url;
      describeUrlSource = "db";
    } else if (
      env.MAPLE_DESCRIBE_PROVIDER_URL &&
      env.MAPLE_DESCRIBE_PROVIDER_URL.length > 0
    ) {
      describeUrl = env.MAPLE_DESCRIBE_PROVIDER_URL;
      describeUrlSource = "env";
    } else {
      describeUrl = DEFAULT_DESCRIBE_OLLAMA_URL;
      describeUrlSource = "default";
    }
  }

  let describeModel = DEFAULT_DESCRIBE_MODELS[describeProvider];
  let describeModelSource: ResolvedEnrichmentConfig["source"]["describe_model"] =
    "default";
  if (db && typeof db.describe_model === "string" && db.describe_model.length > 0) {
    describeModel = db.describe_model;
    describeModelSource = "db";
  } else if (
    env.MAPLE_DESCRIBE_MODEL &&
    env.MAPLE_DESCRIBE_MODEL.length > 0
  ) {
    describeModel = env.MAPLE_DESCRIBE_MODEL;
    describeModelSource = "env";
  }

  let describePrompt = DEFAULT_DESCRIBE_SYSTEM_PROMPT;
  let describePromptSource: ResolvedEnrichmentConfig["source"]["describe_system_prompt"] =
    "default";
  if (
    db &&
    typeof db.describe_system_prompt === "string" &&
    db.describe_system_prompt.length > 0
  ) {
    describePrompt = db.describe_system_prompt;
    describePromptSource = "db";
  } else if (
    env.MAPLE_DESCRIBE_SYSTEM_PROMPT &&
    env.MAPLE_DESCRIBE_SYSTEM_PROMPT.length > 0
  ) {
    describePrompt = env.MAPLE_DESCRIBE_SYSTEM_PROMPT;
    describePromptSource = "env";
  }

  let describeCap = DEFAULT_DESCRIBE_DAILY_CAP_USD;
  let describeCapSource: ResolvedEnrichmentConfig["source"]["describe_daily_cap_usd"] =
    "default";
  if (
    db &&
    typeof db.describe_daily_cap_usd === "number" &&
    Number.isFinite(db.describe_daily_cap_usd) &&
    db.describe_daily_cap_usd > 0
  ) {
    describeCap = db.describe_daily_cap_usd;
    describeCapSource = "db";
  } else if (env.MAPLE_DESCRIBE_DAILY_CAP_USD) {
    const parsed = Number(env.MAPLE_DESCRIBE_DAILY_CAP_USD);
    if (Number.isFinite(parsed) && parsed > 0) {
      describeCap = parsed;
      describeCapSource = "env";
    }
  }

  // ── Face worker (Phase 5) ────────────────────────────────────────────
  let faceEnabled = false;
  let faceEnabledSource: ResolvedEnrichmentConfig["source"]["face_worker_enabled"] =
    "default";
  if (db && typeof db.face_worker_enabled === "boolean") {
    faceEnabled = db.face_worker_enabled;
    faceEnabledSource = "db";
  } else if (env.MAPLE_FACE_WORKER_ENABLED !== undefined) {
    faceEnabled = env.MAPLE_FACE_WORKER_ENABLED === "true";
    faceEnabledSource = "env";
  }

  // Helper for the four "DB → env → unset" face-model URL/SHA fields.
  // Trims and rejects empty strings so a cleared input doesn't masquerade
  // as a saved value.
  function resolveStr(
    dbVal: string | null | undefined,
    envVal: string | undefined,
  ): { value: string | null; source: "db" | "env" | "unset" } {
    if (typeof dbVal === "string" && dbVal.trim().length > 0) {
      return { value: dbVal.trim(), source: "db" };
    }
    if (typeof envVal === "string" && envVal.trim().length > 0) {
      return { value: envVal.trim(), source: "env" };
    }
    return { value: null, source: "unset" };
  }

  let faceModelDir = builtinModelDir();
  let faceModelDirSource: ResolvedEnrichmentConfig["source"]["face_model_dir"] =
    "default";
  if (db && typeof db.face_model_dir === "string" && db.face_model_dir.trim().length > 0) {
    faceModelDir = db.face_model_dir.trim();
    faceModelDirSource = "db";
  } else if (env.MAPLE_MODEL_DIR && env.MAPLE_MODEL_DIR.length > 0) {
    faceModelDir = env.MAPLE_MODEL_DIR;
    faceModelDirSource = "env";
  }

  const faceRetinafaceUrl = resolveStr(
    db?.face_retinaface_url,
    env.MAPLE_FACE_RETINAFACE_URL,
  );
  const faceRetinafaceSha = resolveStr(
    db?.face_retinaface_sha256,
    env.MAPLE_FACE_RETINAFACE_SHA256,
  );
  const faceMfnUrl = resolveStr(
    db?.face_mobilefacenet_url,
    env.MAPLE_FACE_MOBILEFACENET_URL,
  );
  const faceMfnSha = resolveStr(
    db?.face_mobilefacenet_sha256,
    env.MAPLE_FACE_MOBILEFACENET_SHA256,
  );

  // ── OCR worker (Phase 8) ─────────────────────────────────────────────
  let ocrEnabled = false;
  let ocrEnabledSource: ResolvedEnrichmentConfig["source"]["ocr_worker_enabled"] =
    "default";
  if (db && typeof db.ocr_worker_enabled === "boolean") {
    ocrEnabled = db.ocr_worker_enabled;
    ocrEnabledSource = "db";
  } else if (env.MAPLE_OCR_WORKER_ENABLED !== undefined) {
    ocrEnabled = env.MAPLE_OCR_WORKER_ENABLED === "true";
    ocrEnabledSource = "env";
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
    face_retinaface_url: faceRetinafaceUrl.value,
    face_retinaface_sha256: faceRetinafaceSha.value,
    face_mobilefacenet_url: faceMfnUrl.value,
    face_mobilefacenet_sha256: faceMfnSha.value,
    ocr_worker_enabled: ocrEnabled,
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
      face_retinaface_url: faceRetinafaceUrl.source,
      face_retinaface_sha256: faceRetinafaceSha.source,
      face_mobilefacenet_url: faceMfnUrl.source,
      face_mobilefacenet_sha256: faceMfnSha.source,
      ocr_worker_enabled: ocrEnabledSource,
    },
  };
}
