/**
 * The `search_engine` setting (#4463): which engine ranks a text search. `meilisearch` is today's
 * path and the default; `in-process` asks the search child first and falls back to today's path
 * whenever it cannot answer.
 *
 * Read on every text search, so the value is held for {@link SELECTION_TTL_MS}; a save through
 * Settings → AI updates it at once.
 */

import {
  loadEnrichmentConfig,
  saveEnrichmentConfig,
} from '../enrichment/enrichment-config.repo.ts';
import { child as childLogger } from '../log.ts';
import { searchChildConfig } from './search-child-config.ts';
import { inProcessSearch, searchChildPool, stopSearchChildPool } from './search-pool.ts';
import type { FusedSearchHit } from './search-engine-ffi.ts';

export const SEARCH_ENGINES = ['meilisearch', 'in-process'] as const;
export type SearchEngineName = (typeof SEARCH_ENGINES)[number];
export const DEFAULT_SEARCH_ENGINE: SearchEngineName = 'meilisearch';

/** How many fused hits a search asks the child for; filters and paging apply to these. */
export const IN_PROCESS_CANDIDATES = 100;

const SELECTION_TTL_MS = 5_000;
const log = childLogger('search-engine');

let cached: { engine: SearchEngineName; at: number } | null = null;

export function isSearchEngineName(value: unknown): value is SearchEngineName {
  return SEARCH_ENGINES.includes(value as SearchEngineName);
}

export async function selectedSearchEngine(now: number = Date.now()): Promise<SearchEngineName> {
  if (cached && now - cached.at < SELECTION_TTL_MS) return cached.engine;
  const saved = (await loadEnrichmentConfig())?.search_engine;
  const engine = isSearchEngineName(saved) ? saved : DEFAULT_SEARCH_ENGINE;
  cached = { engine, at: now };
  return engine;
}

export async function saveSearchEngine(engine: SearchEngineName): Promise<void> {
  await saveEnrichmentConfig({ search_engine: engine });
  cached = { engine, at: Date.now() };
}

/** Starts the search child for `in-process` and stops it otherwise, so it holds no memory unused. */
export function applySearchEngine(engine: SearchEngineName): void {
  if (engine === 'in-process') searchChildPool(searchChildConfig).start();
  else stopSearchChildPool();
}

/** Boot: start the child when the saved setting asks for it. Never throws. */
export async function startSelectedSearchEngine(): Promise<void> {
  try {
    applySearchEngine(await selectedSearchEngine());
  } catch (err) {
    log.error({ err }, 'could not read the search engine setting; staying on Meilisearch');
  }
}

/**
 * The child's fused ranking for `query`, or null when Meilisearch is selected or the child cannot
 * answer — the caller then takes today's path.
 */
export async function inProcessRanking(query: string): Promise<FusedSearchHit[] | null> {
  if ((await selectedSearchEngine()) !== 'in-process') return null;
  return (await inProcessSearch()?.search(query, IN_PROCESS_CANDIDATES)) ?? null;
}

export function resetSearchEngineSelectionForTests(): void {
  cached = null;
}
