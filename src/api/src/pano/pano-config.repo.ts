/**
 * Persisted pano runtime config. A single row in `app_settings` keyed
 * `id = 'pano'`. Pattern mirrors enrichment-config.repo.ts.
 *
 * Settings (all operator-configurable at runtime via PUT /api/pano/config):
 *   - maple_cli_path  : absolute path to the compiled maple-cli binary
 *   - matcher         : 'classical' (default, no downloads) or 'ml' (opt-in)
 *   - models_dir      : MAPLE_PANO_MODELS directory (ALIKED + LightGlue; ML only)
 *   - ort_dylib_path  : ORT_DYLIB_PATH — libonnxruntime ≥ 1.23 (ML only)
 *   - enabled         : operator on/off toggle (default: false)
 *
 * When `enabled` is false or `maple_cli_path` is absent, POST /api/pano/stitch
 * returns 409 { error: 'pano_not_provisioned', ... }. With `matcher: 'ml'` and
 * either model path unset it returns 409 { error: 'pano_ml_not_provisioned' }
 * rather than silently falling back to classical (#4555).
 */

import path from 'node:path';
import {
  patchAppSettings,
  readAppSettings,
  type SettingsValue,
} from '../db/repos/app-settings.repo.ts';
import { child as childLogger } from '../log.ts';

const DOC_ID = 'pano';

export const PANO_MATCHERS = ['classical', 'ml'] as const;
export type PanoMatcher = (typeof PANO_MATCHERS)[number];
const log = childLogger('pano:config-repo');

export interface PanoConfig {
  /** Absolute path to the maple-cli binary. */
  maple_cli_path?: string | null;
  /** MAPLE_PANO_MODELS directory (ALIKED + LightGlue ONNX model files). */
  models_dir?: string | null;
  /** ORT_DYLIB_PATH — path to libonnxruntime.dylib / .so (>= 1.23). */
  ort_dylib_path?: string | null;
  /** Operator enable/disable toggle. Default false until provisioned. */
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
  source: {
    maple_cli_path: 'db' | 'unset';
    models_dir: 'db' | 'unset';
    ort_dylib_path: 'db' | 'unset';
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

/**
 * Resolve the effective config. Pure function — no side effects.
 * `strategy_supported` is always false here; the route probes it separately.
 */
export function resolvePanoConfig(
  db: PanoConfig | null,
): Omit<ResolvedPanoConfig, 'strategy_supported'> {
  const cliPath = resolveStr(db?.maple_cli_path);
  const modelsDir = resolveStr(db?.models_dir);
  const ortDylib = resolveStr(db?.ort_dylib_path);

  let enabled = false;
  let enabledSource: 'db' | 'default' = 'default';
  if (db && typeof db.enabled === 'boolean') {
    enabled = db.enabled;
    enabledSource = 'db';
  }
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
      enabled: enabledSource,
      matcher: storedMatcher ? 'db' : 'default',
    },
  };
}

/** True when pano is fully provisioned and enabled. */
export function isPanoProvisioned(cfg: Omit<ResolvedPanoConfig, 'strategy_supported'>): boolean {
  return cfg.enabled && cfg.maple_cli_path !== null;
}

/** True when the ML matcher is selected but its models or ONNX Runtime are unset. */
export function isMlMatcherUnprovisioned(
  cfg: Omit<ResolvedPanoConfig, 'strategy_supported'>,
): boolean {
  return cfg.matcher === 'ml' && (cfg.models_dir === null || cfg.ort_dylib_path === null);
}
