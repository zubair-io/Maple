/**
 * The search child's boot: the keyword index on disk is a rebuildable cache, kept across restarts
 * only while its recorded version matches this build's. Vectors are always reloaded from SQLite.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMBEDDER_TEMPLATE_SHAPE_VERSION } from '../enrichment/meilisearch-embedder-template.ts';
import {
  CHANGE_OVERLAP_MS,
  isoBefore,
  loadAllVectors,
  rebuildText,
  VectorFollower,
  type SearchEngineOps,
} from './search-index-sync.ts';
import type { SearchChildState } from './search-protocol.ts';

/** The template shape the text is rendered with, then this layout's own revision. */
export const SEARCH_INDEX_VERSION = `${EMBEDDER_TEMPLATE_SHAPE_VERSION}.1`;

export interface SearchIndexState {
  version: string;
  textWatermark: string;
}

export function readIndexState(stateFile: string): SearchIndexState | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8')) as Partial<SearchIndexState>;
    return typeof parsed.version === 'string' && typeof parsed.textWatermark === 'string'
      ? { version: parsed.version, textWatermark: parsed.textWatermark }
      : null;
  } catch {
    return null;
  }
}

export function writeIndexState(stateFile: string, state: SearchIndexState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
}

/**
 * The saved state when the text index on disk can be reused; otherwise deletes the index
 * directory so the engine opens an empty one, and returns null.
 */
export function reusableIndexState(stateFile: string, indexDir: string): SearchIndexState | null {
  const saved = readIndexState(stateFile);
  if (saved?.version === SEARCH_INDEX_VERSION) return saved;
  rmSync(indexDir, { recursive: true, force: true });
  return null;
}

function earlier(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * Loads the vectors, brings the keyword text up to date and returns the follower that keeps both
 * current. `report` is told the moment the vectors are in, so queries are served while the text
 * catches up.
 */
export async function bootSearchIndex(
  engine: SearchEngineOps,
  saved: SearchIndexState | null,
  stateFile: string,
  report: (state: SearchChildState) => void,
): Promise<VectorFollower> {
  const since = isoBefore(Date.now(), CHANGE_OVERLAP_MS);
  const held = await loadAllVectors(engine);
  // The engine copied the 1.4 GB load buffer; collect it now rather than whenever the heap grows.
  Bun.gc(true);
  const counts = () => engine.counts();
  report({ phase: 'ready', ...counts(), textReady: false });

  const follower = new VectorFollower(
    engine,
    held,
    saved ? earlier(saved.textWatermark, since) : since,
  );
  if (!saved) await rebuildText(engine, [...held]);
  await follower.poll();
  if (counts().texts !== follower.heldCount) await rebuildText(engine, [...held]);

  writeIndexState(stateFile, {
    version: SEARCH_INDEX_VERSION,
    textWatermark: follower.textWatermark,
  });
  report({ phase: 'ready', ...counts(), textReady: true });
  return follower;
}
