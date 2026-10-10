/**
 * The real search child over the real `maple_search_*` library: spawned as a process, it reads a
 * library database, loads its vectors, indexes the template text and answers over IPC.
 *
 * Skips when the native library was not built with `--features search`. The ranked-query case
 * also needs the bge-m3 model cache (2 GB, fetched on first use in production) and skips without
 * it; the rest runs with no embedder, where the engine refuses a query and the pool answers null.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findNativeLib } from 'maple';
import type * as BunFfi from 'bun:ffi';
import { seedSearchAsset } from '../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { searchChildConfig } from './search-child-config.ts';
import { saveEnrichmentConfig } from '../enrichment/enrichment-config.repo.ts';
import { Elysia } from 'elysia';
import { enrichmentRoutes } from '../routes/enrichment.ts';
import { signAccessToken } from '../auth/tokens.ts';
import { withTestEnv } from '../test-support/env.test-helpers.ts';

withTestEnv('MAPLE_JWT_SECRET', 'x'.repeat(32));
import { SearchChildPool, type SearchEngineStatus } from './search-pool.ts';
import type { SearchChildConfig } from './search-protocol.ts';
import { storeVector } from './search.test-helpers.ts';

function hasSearchSymbols(): boolean {
  const libPath = findNativeLib();
  if (!libPath) return false;
  const { dlopen, FFIType } = require('bun:ffi') as typeof BunFfi;
  try {
    dlopen(libPath, { maple_search_open: { args: [FFIType.ptr], returns: FFIType.ptr } }).close();
    return true;
  } catch {
    return false;
  }
}

const modelCacheDir = searchChildConfig().engine.embedder!.model_cache_dir;
const hasModelCache =
  existsSync(modelCacheDir) && readdirSync(modelCacheDir).some((entry) => /bge-m3/i.test(entry));
const searchLibrary = hasSearchSymbols();
if (!searchLibrary) console.warn('search child: no native library with maple_search_*, skipping');

async function waitFor(
  pool: SearchChildPool,
  done: (status: SearchEngineStatus) => boolean,
): Promise<SearchEngineStatus> {
  const deadline = Date.now() + 60_000;
  while (!done(pool.status())) {
    if (Date.now() > deadline)
      throw new Error(`child never settled: ${JSON.stringify(pool.status())}`);
    await Bun.sleep(50);
  }
  return pool.status();
}

describe.skipIf(!searchLibrary)('search child over the real library', () => {
  let live: LiveTestDatabase;
  let dir: string;

  beforeAll(async () => {
    live = await createLiveTestDatabase('file');
    const libraryId = insertFolder(live.db, { slug: 'child', path: '/lib' });
    seedSearchAsset(live.db, libraryId, {
      filename: 'harbour.dng',
      mapleId: 'harbour',
      description: 'a quiet harbour at dawn',
    });
    seedSearchAsset(live.db, libraryId, {
      filename: 'kitchen.dng',
      mapleId: 'kitchen',
      description: 'bread cooling on a kitchen counter',
    });
    storeVector(live.db, 'harbour', 0, '2026-10-10T10:00:00.000Z');
    storeVector(live.db, 'kitchen', 1, '2026-10-10T10:00:01.000Z');
    dir = mkdtempSync(join(tmpdir(), 'maple-search-child-'));
  });

  afterAll(() => {
    live.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function config(embedder: boolean): SearchChildConfig {
    const real = searchChildConfig();
    return {
      dbPath: live.path,
      stateFile: join(dir, embedder ? 'model' : 'bare', 'state.json'),
      engine: {
        index_dir: join(dir, embedder ? 'model' : 'bare', 'text'),
        ...(embedder ? { embedder: real.engine.embedder } : {}),
      },
    };
  }

  test('boots from the database and reports its counts; a query without an embedder falls back', async () => {
    const pool = new SearchChildPool(() => config(false));
    pool.start();
    try {
      const status = await waitFor(pool, (s) => s.phase === 'failed' || s.textReady);
      expect(status).toMatchObject({ phase: 'ready', vectors: 2, texts: 2, textReady: true });
      expect(await pool.search('harbour', 10)).toBeNull();
      expect(pool.status().phase).toBe('ready');
    } finally {
      pool.stop();
    }
  }, 90_000);

  test('reports an embedding model other than bge-m3 as incompatible and answers nothing', async () => {
    await saveEnrichmentConfig({ embedder_model: 'nomic-embed-text' });
    const pool = new SearchChildPool(() => config(false));
    pool.start();
    try {
      const status = await waitFor(pool, (s) => s.phase !== 'starting' && s.phase !== 'loading');
      expect(status).toMatchObject({ phase: 'incompatible-embedder', model: 'nomic-embed-text' });
      expect(status.error).toContain('bge-m3');
      expect(await pool.search('harbour', 10)).toBeNull();
    } finally {
      pool.stop();
      await saveEnrichmentConfig({ embedder_model: null });
    }
  }, 90_000);

  test('restarts when the legacy enrichment endpoint changes the embedding model', async () => {
    const pool = new SearchChildPool(() => config(false));
    pool.start();
    try {
      await waitFor(pool, (s) => s.phase === 'failed' || s.textReady);
      const owner = await signAccessToken(
        { sub: 'search-owner', email: 'owner@example.com', role: 'owner', file_access: true },
        'x'.repeat(32),
      );
      const response = await new Elysia().use(enrichmentRoutes).handle(
        new Request('http://localhost/api/enrichment/config', {
          method: 'PUT',
          headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            nominatim_url: null,
            geocode_worker_enabled: false,
            meilisearch_embedder_model: 'nomic-embed-text',
          }),
        }),
      );
      expect(response.status).toBe(200);

      const status = await waitFor(pool, (s) => s.phase === 'incompatible-embedder');
      expect(status).toMatchObject({ model: 'nomic-embed-text', restarts: 1 });
    } finally {
      pool.stop();
      await saveEnrichmentConfig({ meilisearch_embedder_model: null });
    }
  }, 90_000);

  test.skipIf(!hasModelCache)(
    'ranks a query with the bge-m3 embedder and the keyword leg',
    async () => {
      const pool = new SearchChildPool(() => config(true));
      pool.start();
      try {
        await waitFor(pool, (s) => s.phase === 'failed' || s.textReady);
        const hits = await pool.search('harbour', 10);
        expect(hits?.[0]).toMatchObject({ id: 'harbour', textRank: 1 });
      } finally {
        pool.stop();
      }
    },
    180_000,
  );
});
