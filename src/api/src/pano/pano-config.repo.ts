/**
 * Persisted pano runtime config. A single document in `app_settings`
 * keyed by `_id: "pano"`. Pattern mirrors enrichment-config.repo.ts.
 *
 * Settings (all operator-configurable at runtime via PUT /api/pano/config):
 *   - maple_cli_path  : absolute path to the compiled maple-cli binary
 *   - models_dir      : MAPLE_PANO_MODELS directory (ALIKED + LightGlue)
 *   - ort_dylib_path  : ORT_DYLIB_PATH — libonnxruntime ≥ 1.23 shared lib
 *   - enabled         : operator on/off toggle (default: false)
 *
 * When `enabled` is false or `maple_cli_path` is absent, POST /api/pano/stitch
 * returns 409 { error: 'pano_not_provisioned', ... }.
 */

import path from 'node:path';
import { getDb } from '../db/client.ts';
import { child as childLogger } from '../log.ts';

const COLL = 'app_settings';
const DOC_ID = 'pano';
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
  /** Whether the binary at maple_cli_path supports --strategy (probed at
   * request time; cached for the life of the request). */
  strategy_supported: boolean;
  source: {
    maple_cli_path: 'db' | 'unset';
    models_dir: 'db' | 'unset';
    ort_dylib_path: 'db' | 'unset';
    enabled: 'db' | 'default';
  };
}

/** Read the persisted config. Returns null when no row exists (first boot). */
export async function loadPanoConfig(): Promise<PanoConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<PanoConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Partial upsert — only supplied fields are touched. */
export async function savePanoConfig(patch: Partial<PanoConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { 'config.updated_at': Date.now() };
  if (patch.maple_cli_path !== undefined) set['config.maple_cli_path'] = patch.maple_cli_path;
  if (patch.models_dir !== undefined) set['config.models_dir'] = patch.models_dir;
  if (patch.ort_dylib_path !== undefined) set['config.ort_dylib_path'] = patch.ort_dylib_path;
  if (patch.enabled !== undefined) set['config.enabled'] = patch.enabled;
  await db.collection(COLL).updateOne({ _id: DOC_ID } as never, { $set: set }, { upsert: true });
  log.info({ patch }, 'pano config saved');
}

function resolvePath(dbVal: string | null | undefined): {
  value: string | null;
  source: 'db' | 'unset';
} {
  if (typeof dbVal === 'string' && dbVal.trim().length > 0) {
    const trimmed = dbVal.trim();
    if (path.isAbsolute(trimmed) && !trimmed.startsWith('-')) {
      return { value: trimmed, source: 'db' };
    }
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
  const cliPath = resolvePath(db?.maple_cli_path);
  const modelsDir = resolvePath(db?.models_dir);
  const ortDylib = resolvePath(db?.ort_dylib_path);

  let enabled = false;
  let enabledSource: 'db' | 'default' = 'default';
  if (db && typeof db.enabled === 'boolean') {
    enabled = db.enabled;
    enabledSource = 'db';
  }

  return {
    maple_cli_path: cliPath.value,
    models_dir: modelsDir.value,
    ort_dylib_path: ortDylib.value,
    enabled,
    source: {
      maple_cli_path: cliPath.source,
      models_dir: modelsDir.source,
      ort_dylib_path: ortDylib.source,
      enabled: enabledSource,
    },
  };
}

/** True when pano is fully provisioned and enabled. */
export function isPanoProvisioned(cfg: Omit<ResolvedPanoConfig, 'strategy_supported'>): boolean {
  return cfg.enabled && cfg.maple_cli_path !== null;
}
