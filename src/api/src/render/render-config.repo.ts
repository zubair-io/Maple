/**
 * Persisted render runtime config — the operator ramp/kill switch for the web
 * GPU live-render path (#1062, epic #925). Mirrors the observability- and
 * display-config shape: a single document in `app_settings` keyed by
 * `_id: "render"`.
 *
 * Config lives ENTIRELY in the database — set it from web Settings → Workers
 * (or `PUT /api/render/config`). There is no env-var fallback here: an
 * operator must be able to flip the switch without a restart or shell access,
 * which is the whole point of the ticket. When no row has been written the
 * resolver returns the built-in default (GPU live render ON), so a fresh
 * database behaves exactly like today.
 *
 * The only consumer is the web client, which pulls the resolved shape from
 * `GET /api/render/config` at startup and on a periodic refresh, and routes
 * its live RAW render through either the wgpu/WGSL GPU chain or the
 * threaded-CPU `render_bytes` fallback accordingly.
 */

import { getDb } from '../db/client.ts';

const COLL = 'app_settings';
const DOC_ID = 'render';

/**
 * Default for `gpu_live_render_enabled` when the operator has never saved a
 * value. `true` preserves today's behaviour — #1059 made the GPU live path the
 * web default, and this setting only exists to take it away again.
 */
export const DEFAULT_GPU_LIVE_RENDER_ENABLED = true;

/**
 * DB shape. The field is `null`/missing until the operator saves an explicit
 * value; the resolver then falls back to the built-in default.
 */
export interface RenderConfig {
  /** Web GPU live-render ramp/kill. `null`/missing → resolver default true. */
  gpu_live_render_enabled?: boolean | null;
  updated_at?: number;
}

interface RenderConfigDoc {
  _id: string;
  config: RenderConfig;
}

/** Resolved shape returned over HTTP. `source` tells the UI whether it is
 * looking at a saved value or the built-in default. */
export interface ResolvedRenderConfig {
  gpu_live_render_enabled: boolean;
  source: {
    gpu_live_render_enabled: 'db' | 'default';
  };
}

/**
 * Read the persisted config. Returns `null` when no row exists yet (fresh
 * database) or when the database is unreachable — `resolveRenderConfig` then
 * supplies the built-in default, so an operator with a broken Mongo gets
 * today's behaviour rather than an unrendered editor.
 */
export async function loadRenderConfig(): Promise<RenderConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<RenderConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only the fields you supply are
 * touched, the rest of the config doc is preserved. */
export async function saveRenderConfig(patch: Partial<RenderConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    'config.updated_at': Date.now(),
  };
  if (patch.gpu_live_render_enabled !== undefined) {
    set['config.gpu_live_render_enabled'] = patch.gpu_live_render_enabled;
  }
  await db.collection(COLL).updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/**
 * Resolve the effective config: a saved boolean wins, anything else (missing
 * row, `null`, a hand-edited non-boolean) falls back to the built-in default.
 * Pure function — no side effects, no env reads, easy to test.
 */
export function resolveRenderConfig(db: RenderConfig | null): ResolvedRenderConfig {
  const saved = db?.gpu_live_render_enabled;
  const fromDb = typeof saved === 'boolean';
  return {
    gpu_live_render_enabled: fromDb ? saved : DEFAULT_GPU_LIVE_RENDER_ENABLED,
    source: { gpu_live_render_enabled: fromDb ? 'db' : 'default' },
  };
}
