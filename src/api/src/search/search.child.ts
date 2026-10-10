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
import { openSearchEngine, type SearchEngine } from './search-engine-ffi.ts';
import {
  bootSearchIndex,
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

function followChanges(follower: VectorFollower, config: SearchChildConfig): void {
  let polling = false;
  const tick = async (): Promise<void> => {
    if (polling || !engine) return;
    polling = true;
    try {
      const touched = await follower.poll();
      if (touched > 0) {
        writeIndexState(config.stateFile, {
          version: SEARCH_INDEX_VERSION,
          textWatermark: follower.textWatermark,
        });
        report({ phase: 'ready', ...engine.counts(), textReady: true });
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'search poll failed');
    } finally {
      polling = false;
    }
  };
  setInterval(() => void tick(), POLL_INTERVAL_MS);
}

async function start(config: SearchChildConfig): Promise<void> {
  if (engine) return;
  report({ phase: 'loading', vectors: 0, texts: 0, textReady: false });
  try {
    await openSqlitePool({ path: config.dbPath, readers: 1 });
    const saved = reusableIndexState(config.stateFile, config.engine.index_dir);
    const opened = openSearchEngine(config.engine);
    engine = opened;
    const follower = await bootSearchIndex(opened, saved, config.stateFile, report);
    followChanges(follower, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
    post({ type: 'query', id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

process.on('message', (raw: unknown) => {
  const request = raw as SearchChildRequest;
  if (!request || typeof request !== 'object') return;
  if (request.type === 'start') void start(request.config);
  else if (request.type === 'query') answer(request.id, request.query, request.k);
});
