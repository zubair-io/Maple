import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { seedSearchAsset } from '../db/repos/search.test-helpers.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import {
  bootSearchIndex,
  readIndexState,
  reusableIndexState,
  SEARCH_INDEX_VERSION,
} from './search-index-boot.ts';
import type { SearchChildState } from './search-protocol.ts';
import { RecordingEngine, storeVector } from './search.test-helpers.ts';

let live: LiveTestDatabase;
let dir: string;

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { slug: 'boot', path: '/lib' });
  seedSearchAsset(live.db, libraryId, { filename: 'harbour.dng', mapleId: 'harbour' });
  storeVector(live.db, 'harbour', 0, '2020-01-01T00:00:00.000Z');
  dir = mkdtempSync(join(tmpdir(), 'maple-search-boot-'));
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a first boot rebuilds the text, records the version and reports ready twice', async () => {
  const engine = new RecordingEngine();
  const states: SearchChildState[] = [];
  const stateFile = join(dir, 'state.json');

  await bootSearchIndex(engine, 'bge-m3', null, stateFile, (state) => states.push(state));

  expect(engine.clears).toBe(1);
  expect(engine.counts()).toEqual({ vectors: 1, texts: 1 });
  expect(readIndexState(stateFile)?.version).toBe(SEARCH_INDEX_VERSION);
  expect(states.at(-1)).toMatchObject({ model: 'bge-m3', skippedVectors: 0 });
  expect(states.map((state) => [state.phase, state.textReady])).toEqual([
    ['ready', false],
    ['ready', true],
  ]);
});

test('a boot on a current index only catches up instead of rebuilding', async () => {
  const engine = new RecordingEngine();
  engine.texts.set('harbour', 'kept from the last run');
  const saved = { version: SEARCH_INDEX_VERSION, textWatermark: '2020-06-01T00:00:00.000Z' };

  await bootSearchIndex(engine, 'bge-m3', saved, join(dir, 'state.json'), () => {});

  expect(engine.clears).toBe(0);
  expect(engine.texts.get('harbour')).toBe('kept from the last run');
});

test('a boot whose text count disagrees with the vectors rebuilds after all', async () => {
  const engine = new RecordingEngine();
  const saved = { version: SEARCH_INDEX_VERSION, textWatermark: '2020-06-01T00:00:00.000Z' };

  await bootSearchIndex(engine, 'bge-m3', saved, join(dir, 'state.json'), () => {});

  expect(engine.clears).toBe(1);
  expect(engine.counts()).toEqual({ vectors: 1, texts: 1 });
});

test('an index from another version is deleted before the engine opens it', () => {
  const indexDir = join(dir, 'text');
  const stateFile = join(dir, 'state.json');
  mkdirSync(indexDir);
  writeFileSync(stateFile, JSON.stringify({ version: '0.0', textWatermark: '2026-01-01' }));

  expect(reusableIndexState(stateFile, indexDir)).toBeNull();
  expect(existsSync(indexDir)).toBe(false);

  writeFileSync(
    stateFile,
    JSON.stringify({ version: SEARCH_INDEX_VERSION, textWatermark: '2026-01-01' }),
  );
  mkdirSync(indexDir);
  expect(reusableIndexState(stateFile, indexDir)?.textWatermark).toBe('2026-01-01');
  expect(existsSync(indexDir)).toBe(true);
});
