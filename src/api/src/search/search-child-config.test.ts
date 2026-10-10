import { afterEach, expect, test } from 'bun:test';
import { searchChildConfig, searchModelCacheDir } from './search-child-config.ts';

const saved = {
  sqlite: process.env.MAPLE_SQLITE_PATH,
  models: process.env.MAPLE_MODEL_DIR,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('MAPLE_SQLITE_PATH', saved.sqlite);
  restore('MAPLE_MODEL_DIR', saved.models);
});

test('the model cache and the index sit beside the database, on the data volume', () => {
  process.env.MAPLE_SQLITE_PATH = '/data/maple.sqlite';
  delete process.env.MAPLE_MODEL_DIR;

  const config = searchChildConfig();

  expect(searchModelCacheDir()).toBe('/data/.maple/models/fastembed');
  expect(config.engine.embedder?.model_cache_dir).toBe('/data/.maple/models/fastembed');
  expect(config.engine.index_dir).toBe('/data/.maple/search/text');
  expect(config.stateFile).toBe('/data/.maple/search/state.json');
});

test('MAPLE_MODEL_DIR, which the face and whisper models honour, overrides the model cache', () => {
  process.env.MAPLE_SQLITE_PATH = '/data/maple.sqlite';
  process.env.MAPLE_MODEL_DIR = '/models';

  expect(searchModelCacheDir()).toBe('/models/fastembed');
  expect(searchChildConfig().engine.index_dir).toBe('/data/.maple/search/text');
});
