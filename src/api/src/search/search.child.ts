/**
 * Child-process entry that owns the in-process search engine (#4463): the bge-m3 query model, every
 * document vector and the Tantivy keyword index. A query is tens of milliseconds of synchronous
 * native work and the engine holds a few gigabytes, so it lives here rather than in the API
 * process; a crash kills only this child, which `search-pool.ts` restarts.
 *
 * Reads the library through its own one-reader SQLite pool and never writes to it.
 */

import { installChildHardening } from '../runtime/child-process-worker.ts';
import { reportMemoryToParent, startMemoryTelemetry } from '../runtime/memory-telemetry.ts';
import { openSqlitePool } from '../db/sqlite/index.ts';
import { child as childLogger } from '../log.ts';
import { loadEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from '../enrichment/enrichment-config.resolve.ts';
import { openSearchEngine, type SearchEngine } from './search-engine-ffi.ts';
import { normalisedModel } from '../db/repos/asset-vectors.search.ts';
import {
  bootSearchIndex,
  incompatibleEmbedderState,
  readyState,
  reusableIndexState,
  SEARCH_INDEX_VERSION,
  writeIndexState,
} from './search-index-boot.ts';
import type { VectorFollower } from './search-index-sync.ts';
import type {
  SearchChildConfig,
  SearchChildRequest,
  SearchChildResponse,
  SearchChildState,
} from './search-protocol.ts';

const POLL_INTERVAL_MS = 5_000;

installChildHardening('search');
startMemoryTelemetry({ process: 'search', onSample: reportMemoryToParent });

const log = childLogger('search-child');
let engine: SearchEngine | null = null;

function post(message: SearchChildResponse): void {
  process.send?.(message);
}

function report(state: SearchChildState): void {
  post({ type: 'state', state });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pollOnce(
  follower: VectorFollower,
  config: SearchChildConfig,
  model: string,
  opened: SearchEngine,
): Promise<void> {
  if ((await follower.poll()) === 0) return;
  writeIndexState(config.stateFile, {
    version: SEARCH_INDEX_VERSION,
    textWatermark: follower.textWatermark,
  });
  report(await readyState(opened, model, true));
}

function followChanges(
  follower: VectorFollower,
  config: SearchChildConfig,
  model: string,
  opened: SearchEngine,
): void {
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    pollOnce(follower, config, model, opened)
      .finally(() => {
        polling = false;
      })
      .catch((err: unknown) => log.warn({ err: errorMessage(err) }, 'search poll failed'));
  }, POLL_INTERVAL_MS);
}

async function resolvedEmbedderModel(): Promise<string> {
  return resolveEnrichmentConfig(await loadEnrichmentConfig()).embedder_model;
}

/**
 * Asks the parent for a fresh child once the embedding model this one loaded is no longer the
 * configured one. Read from the settings row itself, so it catches every way the model can
 * change — Settings → AI, the legacy enrichment-config endpoint, a semantic-search assignment —
 * without each writer having to remember to restart search.
 */
function watchEmbedderModel(model: string): void {
  const timer = setInterval(() => {
    resolvedEmbedderModel()
      .then((current) => {
        if (normalisedModel(current) === normalisedModel(model)) return;
        clearInterval(timer);
        post({ type: 'reload', reason: `embedding model changed from "${model}" to "${current}"` });
      })
      .catch((err: unknown) =>
        log.warn({ err: errorMessage(err) }, 'embedding model re-read failed'),
      );
  }, POLL_INTERVAL_MS);
}

async function start(config: SearchChildConfig): Promise<void> {
  if (engine) return;
  report({ phase: 'loading', vectors: 0, texts: 0, textReady: false });
  try {
    await openSqlitePool({ path: config.dbPath, readers: 1 });
    const saved = reusableIndexState(config.stateFile, config.engine.index_dir);
    const model = await resolvedEmbedderModel();
    watchEmbedderModel(model);
    const incompatible = incompatibleEmbedderState(model);
    if (incompatible) {
      report(incompatible);
      return;
    }
    const opened = openSearchEngine(config.engine);
    engine = opened;
    const follower = await bootSearchIndex(opened, model, saved, config.stateFile, report);
    followChanges(follower, config, model, opened);
  } catch (err) {
    const message = errorMessage(err);
    log.error({ err: message }, 'search engine failed to start');
    report({ phase: 'failed', vectors: 0, texts: 0, textReady: false, error: message });
  }
}

function answer(id: number, query: string, k: number): void {
  if (!engine) {
    post({ type: 'query', id, ok: false, error: 'search engine is not loaded' });
    return;
  }
  try {
    post({ type: 'query', id, ok: true, hits: engine.query(query, k) });
  } catch (err) {
    post({ type: 'query', id, ok: false, error: errorMessage(err) });
  }
}

function dispatch(request: SearchChildRequest): void {
  if (request.type === 'start') void start(request.config);
  else answer(request.id, request.query, request.k);
}

process.on('message', (raw: unknown) => dispatch(raw as SearchChildRequest));
