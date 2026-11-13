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
import { vectorFromBase64 } from '../enrichment/vector-codec.ts';
import { withTestEnv } from '../test-support/env.test-helpers.ts';
import ollamaReference from './__fixtures__/bge-m3-ollama-reference.json';

/**
 * Unit vectors Ollama 0.40.10's `bge-m3:latest` returned for a typical document and a 5,000-byte
 * one (past the 512 tokens the query model used to stop at), recorded for #5445.
 */
const REFERENCES = Object.values(ollamaReference).map(({ text, vector }) => ({
  text,
  vector: vectorFromBase64(vector),
}));

const cosine = (a: Float32Array, b: Float32Array): number =>
  a.reduce((sum, value, index) => sum + value * b[index]!, 0);

const maxAbsDifference = (a: Float32Array, b: Float32Array): number =>
  a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index]!)), 0);

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

  test('an engine without an embedder refuses a document batch as a failure, not a wait', async () => {
    const pool = new SearchChildPool(() => config(false));
    pool.start();
    try {
      await waitFor(pool, (s) => s.phase === 'failed' || s.textReady);
      expect(await pool.embed(['a quiet harbour'])).toMatchObject({ ok: false, waiting: false });
    } finally {
      pool.stop();
    }
  }, 90_000);

  test.skipIf(!hasModelCache)(
    'embeds documents in the child as Ollama bge-m3 did, within float tolerance',
    async () => {
      const pool = new SearchChildPool(() => config(true));
      pool.start();
      try {
        await waitFor(pool, (s) => s.phase === 'failed' || s.textReady);
        const outcome = await pool.embed(REFERENCES.map((reference) => reference.text));
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        REFERENCES.forEach((reference, index) => {
          const local = outcome.vectors[index]!;
          expect(cosine(local, reference.vector)).toBeGreaterThan(0.9999);
          expect(maxAbsDifference(local, reference.vector)).toBeLessThan(2e-3);
        });
      } finally {
        pool.stop();
      }
    },
    180_000,
  );

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
