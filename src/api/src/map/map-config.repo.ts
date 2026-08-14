/**
 * Persisted map tile-source config (Map T2, #2826). Mirrors the
 * observability-config shape: a single document in `app_settings` keyed by
 * `_id: "map"`.
 *
 * Design: `docs/superpowers/specs/2026-08-14-photo-map-view-design.md` §
 * "Tile source setting (web only)". The web map (MapLibre GL) needs a
 * style/tile URL to fetch base-map imagery from. That URL is a DB-backed
 * setting — operator-editable at runtime, no redeploy, no shell access —
 * rather than an env var, per CLAUDE.md "configure via the settings system,
 * not new env vars". It defaults to a public OpenStreetMap raster XYZ tile
 * source so a fresh self-hosted deploy renders a map with zero
 * configuration.
 *
 * Privacy: this URL is used ONLY to fetch base-map tile imagery. Photo
 * coordinates are never sent to it — pins and heatmap data come from
 * Maple's own `/api/map/clusters` endpoint (a separate ticket), and nothing
 * in this module or its route ever appends asset coordinates to the tile
 * URL or to any request made against it.
 */

import { getDb } from '../db/client.ts';

const COLL = 'app_settings';
const DOC_ID = 'map';

/**
 * Default tile source: OpenStreetMap's standard XYZ raster tile endpoint.
 * No API key required, works for every self-hoster out of the box.
 * `{z}/{x}/{y}` are MapLibre's raster-source substitution placeholders —
 * kept literal (not percent-encoded) so the client can use this value
 * directly as a `RasterSourceSpecification.tiles[0]` entry.
 */
export const DEFAULT_MAP_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export interface MapConfig {
  /** Style/tile URL the web map fetches base-map imagery from. Either a
   * raw XYZ tile URL template (containing `{z}`/`{x}`/`{y}`) or a MapLibre
   * style JSON URL — both are just URLs from this module's point of view.
   * `null`/missing → resolver falls back to `DEFAULT_MAP_TILE_URL`. */
  tile_url?: string | null;
  updated_at?: number;
}

interface MapConfigDoc {
  _id: string;
  config: MapConfig;
}

export interface ResolvedMapConfig {
  tile_url: string;
  source: {
    tile_url: 'db' | 'default';
  };
}

/** Read the persisted config. Returns `null` when no row exists yet (first
 * boot of a fresh database). The resolver then supplies the built-in
 * default. */
export async function loadMapConfig(): Promise<MapConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<MapConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only the fields you supply are
 * touched, the rest of the config doc is preserved. */
export async function saveMapConfig(patch: Partial<MapConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { 'config.updated_at': Date.now() };
  if (patch.tile_url !== undefined) {
    set['config.tile_url'] = patch.tile_url;
  }
  await db.collection(COLL).updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/**
 * Validate an operator-supplied tile URL. A "sane URL check", not a
 * scheme/host allowlist framework: it must parse as a URL and use http(s).
 *
 * Returns the trimmed, ORIGINAL string (not `URL.href`) on success — the
 * WHATWG URL parser percent-encodes `{`/`}` in the reconstructed href,
 * which would corrupt the literal `{z}/{x}/{y}` placeholders MapLibre's
 * raster-source substitution relies on. Returns `null` for empty/absent
 * input (meaning "no override, use the default"), or `{ error }` for a
 * malformed value.
 */
export function validateTileUrl(raw: string | null): string | null | { error: string } {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Unsupported protocol: ${parsed.protocol}` };
  }
  return trimmed;
}

/**
 * Resolve the effective config: a valid DB override wins; otherwise (unset,
 * or a hand-edited row holding an invalid value) fall back to
 * `DEFAULT_MAP_TILE_URL`. Pure function — no side effects, easy to test.
 */
export function resolveMapConfig(db: MapConfig | null): ResolvedMapConfig {
  if (db && typeof db.tile_url === 'string') {
    const validated = validateTileUrl(db.tile_url);
    if (typeof validated === 'string') {
      return { tile_url: validated, source: { tile_url: 'db' } };
    }
  }
  return { tile_url: DEFAULT_MAP_TILE_URL, source: { tile_url: 'default' } };
}
