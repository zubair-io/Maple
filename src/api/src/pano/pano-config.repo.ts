/**
 * Persisted pano runtime config. A single row in `app_settings` keyed
 * `id = 'pano'`. Pattern mirrors enrichment-config.repo.ts.
 *
 * Settings (all operator-configurable at runtime via PUT /api/pano/config):
 *   - maple_cli_path  : absolute path to the compiled maple-cli binary; when
 *                       unset, the one the Docker image ships (MAPLE_PANO_CLI)
 *   - matcher         : 'classical' (default, no downloads) or 'ml' (opt-in)
 *   - models_dir      : ALIKED + LightGlue model directory (ML only)
 *   - ort_dylib_path  : libonnxruntime ≥ 1.23 (ML only)
 *   - enabled         : operator on/off toggle (default: on when the image
 *                       ships maple-cli, off otherwise)
 *
 * The two ML paths still fall back to the legacy MAPLE_PANO_MODELS /
 * ORT_DYLIB_PATH environment variables when unset here, so setups provisioned
 * before #4555 keep stitching; that fallback is deprecated in favour of the
 * settings page. How a stitch runs from this config is `pano-engine.ts`.
 */

import path from 'node:path';
import {
  patchAppSettings,
  readAppSettings,
  type SettingsValue,
} from '../db/repos/app-settings.repo.ts';
import { child as childLogger } from '../log.ts';

const DOC_ID = 'pano';

const PANO_MATCHERS = ['classical', 'ml'] as const;
export type PanoMatcher = (typeof PANO_MATCHERS)[number];
const log = childLogger('pano:config-repo');

export interface PanoConfig {
  /** Absolute path to the maple-cli binary. */
  maple_cli_path?: string | null;
  /** MAPLE_PANO_MODELS directory (ALIKED + LightGlue ONNX model files). */
  models_dir?: string | null;
  /** ORT_DYLIB_PATH — path to libonnxruntime.dylib / .so (>= 1.23). */
  ort_dylib_path?: string | null;
  /** Operator enable/disable toggle. Defaults on only with a bundled maple-cli. */
  enabled?: boolean | null;
  /** Feature detector/matcher the stitch runs with. Default classical. */
  matcher?: PanoMatcher | null;
  updated_at?: number;
}

interface PanoConfigDoc {
  _id: string;
  config: PanoConfig;
}

export interface ResolvedPanoConfig {
  maple_cli_path: string | null;
  models_dir: string | null;
  ort_dylib_path: string | null;
  enabled: boolean;
  matcher: PanoMatcher;
  /** Whether the binary at maple_cli_path supports --strategy (probed at
   * request time; cached for the life of the request). */
  strategy_supported: boolean;
  /** Whether the binary accepts --features-engine; one without it is ML-only. */
  features_engine_supported: boolean;
  source: {
    maple_cli_path: 'db' | 'bundled' | 'unset';
    models_dir: PathSource;
    ort_dylib_path: PathSource;
    enabled: 'db' | 'default';
    matcher: 'db' | 'default';
  };
}

/** Read the persisted config. Returns null when no row exists (first boot). */
export async function loadPanoConfig(): Promise<PanoConfig | null> {
  try {
    const doc = await readAppSettings<PanoConfigDoc>(DOC_ID);
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Partial upsert — only supplied fields are touched. */
export async function savePanoConfig(patch: Partial<PanoConfig>): Promise<void> {
  const set: Record<string, SettingsValue | undefined> = { 'config.updated_at': Date.now() };
  if (patch.maple_cli_path !== undefined) set['config.maple_cli_path'] = patch.maple_cli_path;
  if (patch.models_dir !== undefined) set['config.models_dir'] = patch.models_dir;
  if (patch.ort_dylib_path !== undefined) set['config.ort_dylib_path'] = patch.ort_dylib_path;
  if (patch.enabled !== undefined) set['config.enabled'] = patch.enabled;
  if (patch.matcher !== undefined) set['config.matcher'] = patch.matcher;
  await patchAppSettings(DOC_ID, set);
  log.info({ patch }, 'pano config saved');
}

type PathSource = 'db' | 'env' | 'unset';

/** The config minus the two flags probed from the binary at request time. */
export type PanoConfigResolution = Omit<
  ResolvedPanoConfig,
  'strategy_supported' | 'features_engine_supported'
>;

function resolveStr(dbVal: string | null | undefined): {
  value: string | null;
  source: 'db' | 'unset';
} {
  if (typeof dbVal === 'string' && dbVal.trim().length > 0) {
    const trimmed = dbVal.trim();
    // Security hardening: reject paths that start with a hyphen (flag injection)
    // or are not absolute (ambiguity).
    if (trimmed.startsWith('-') || !path.isAbsolute(trimmed)) {
      log.warn({ path: trimmed }, 'pano config: ignoring non-absolute or hyphen-prefixed path');
      return { value: null, source: 'unset' };
    }
    return { value: trimmed, source: 'db' };
  }
  return { value: null, source: 'unset' };
}

/** The saved path, else the binary the Docker image ships (#5493). */
function resolveCliPath(
  dbVal: string | null | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { value: string | null; source: 'db' | 'bundled' | 'unset' } {
  const saved = typeof dbVal === 'string' && dbVal.trim().length > 0;
  const fromDb = resolveStr(dbVal);
  if (saved) return fromDb;
  const bundled = resolveStr(env.MAPLE_PANO_CLI);
  return bundled.value === null ? fromDb : { value: bundled.value, source: 'bundled' };
}

const legacyEnvNoticeLogged = new Set<string>();

function resolvePathWithLegacyEnv(
  dbVal: string | null | undefined,
  envName: 'MAPLE_PANO_MODELS' | 'ORT_DYLIB_PATH',
  env: Readonly<Record<string, string | undefined>>,
): { value: string | null; source: PathSource } {
  const fromDb = resolveStr(dbVal);
  if (fromDb.value !== null) return fromDb;
  const fromEnv = resolveStr(env[envName]);
  if (fromEnv.value === null) return fromDb;
  if (!legacyEnvNoticeLogged.has(envName)) {
    legacyEnvNoticeLogged.add(envName);
    log.warn(
      { envName },
      'pano config: falling back to a deprecated environment variable; save the path in Settings > Pano',
    );
  }
  return { value: fromEnv.value, source: 'env' };
}

/**
 * Resolve the effective config from the stored row and the process
 * environment (the legacy ML path fallback).
 */
export function resolvePanoConfig(
  db: PanoConfig | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PanoConfigResolution {
  const cliPath = resolveCliPath(db?.maple_cli_path, env);
  const modelsDir = resolvePathWithLegacyEnv(db?.models_dir, 'MAPLE_PANO_MODELS', env);
  const ortDylib = resolvePathWithLegacyEnv(db?.ort_dylib_path, 'ORT_DYLIB_PATH', env);

  const storedEnabled = typeof db?.enabled === 'boolean' ? db.enabled : null;
  const enabled = storedEnabled ?? cliPath.source === 'bundled';
  const storedMatcher = PANO_MATCHERS.find((m) => m === db?.matcher);

  return {
    maple_cli_path: cliPath.value,
    models_dir: modelsDir.value,
    ort_dylib_path: ortDylib.value,
    enabled,
    matcher: storedMatcher ?? 'classical',
    source: {
      maple_cli_path: cliPath.source,
      models_dir: modelsDir.source,
      ort_dylib_path: ortDylib.source,
      enabled: storedEnabled === null ? 'default' : 'db',
      matcher: storedMatcher ? 'db' : 'default',
    },
  };
}

/** True when pano is fully provisioned and enabled. */
export function isPanoProvisioned(cfg: PanoConfigResolution): boolean {
  return cfg.enabled && cfg.maple_cli_path !== null;
}
