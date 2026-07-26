/**
 * enrichment-config repo tests — pure resolver logic + real-Mongo round-trip.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { MongoClient, type Db } from 'mongodb';
import {
  DEFAULT_DESCRIBE_MODELS,
  DEFAULT_MEILISEARCH_EMBEDDER_MODEL,
  DEFAULT_MEILISEARCH_EMBEDDER_URL,
  DEFAULT_MEILISEARCH_SEMANTIC_RATIO,
  DEFAULT_MEILISEARCH_TASK_TIMEOUT_SECONDS,
  QWEN_VL_OLLAMA_TAG,
  loadEnrichmentConfig,
  saveEnrichmentConfig,
} from './enrichment-config.repo.ts';
import { resolveEnrichmentConfig } from './enrichment-config.resolve.ts';

describe('QWEN_VL_OLLAMA_TAG — pinned literal', () => {
  // Hyphen vs no-hyphen burned us once (PR #182 follow-up) for the qwen2.5
  // generation: the Qwen team names it `qwen2.5-vl` but Ollama's library
  // published it as `qwen2.5vl` (no hyphen). The qwen3 generation reverses
  // this — Ollama's tag IS dashed (`qwen3-vl:8b`). Pinning the literal so
  // a future rename doesn't 404 in CI instead of in prod.
  it("matches Ollama's library tag exactly", () => {
    expect(QWEN_VL_OLLAMA_TAG).toBe('qwen3-vl:8b');
  });

  it('is the default for the Ollama provider', () => {
    expect(DEFAULT_DESCRIBE_MODELS.ollama).toBe(QWEN_VL_OLLAMA_TAG);
  });
});

const TEST_DB = `maple_test_enrichment_cfg_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[enrichment-config.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

beforeEach(async () => {
  if (!mongoReachable) return;
  await db!.collection('app_settings').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    await mongo.db(TEST_DB).dropDatabase();
    await mongo.close();
  }
  const { closeDb } = await import('../db/client.ts');
  await closeDb();
});

describe('resolveEnrichmentConfig — pure logic', () => {
  it('falls back to env when there is no DB row', () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_NOMINATIM_URL: 'http://nominatim.lan:8080',
      MAPLE_GEOCODE_WORKER_ENABLED: 'true',
    });
    expect(r.nominatim_url).toBe('http://nominatim.lan:8080');
    expect(r.geocode_worker_enabled).toBe(true);
    expect(r.source.nominatim_url).toBe('env');
    expect(r.source.geocode_worker_enabled).toBe('env');
  });

  it('DB wins over env', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: 'http://db.lan', geocode_worker_enabled: false },
      { MAPLE_NOMINATIM_URL: 'http://env.lan', MAPLE_GEOCODE_WORKER_ENABLED: 'true' },
    );
    expect(r.nominatim_url).toBe('http://db.lan');
    expect(r.geocode_worker_enabled).toBe(false);
    expect(r.source.nominatim_url).toBe('db');
    expect(r.source.geocode_worker_enabled).toBe('db');
  });

  it('returns defaults when neither DB nor env have a value', () => {
    const r = resolveEnrichmentConfig(null, {});
    expect(r.nominatim_url).toBeNull();
    expect(r.geocode_worker_enabled).toBe(true);
    expect(r.source.nominatim_url).toBe('unset');
    expect(r.source.geocode_worker_enabled).toBe('default');
  });

  it("MAPLE_GEOCODE_WORKER_ENABLED='false' disables", () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_GEOCODE_WORKER_ENABLED: 'false',
    });
    expect(r.geocode_worker_enabled).toBe(false);
    expect(r.source.geocode_worker_enabled).toBe('env');
  });

  it('DB null URL falls through to env', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true },
      { MAPLE_NOMINATIM_URL: 'http://env.lan' },
    );
    expect(r.nominatim_url).toBe('http://env.lan');
    expect(r.source.nominatim_url).toBe('env');
  });

  it('rate limit defaults to 10 when neither DB nor env set it', () => {
    const r = resolveEnrichmentConfig(null, {});
    expect(r.nominatim_rate_limit_per_sec).toBe(10);
    expect(r.source.nominatim_rate_limit_per_sec).toBe('default');
  });

  it('rate limit reads MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC from env', () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: '5',
    });
    expect(r.nominatim_rate_limit_per_sec).toBe(5);
    expect(r.source.nominatim_rate_limit_per_sec).toBe('env');
  });

  it('rate limit DB wins over env', () => {
    const r = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        nominatim_rate_limit_per_sec: 2,
      },
      { MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: '20' },
    );
    expect(r.nominatim_rate_limit_per_sec).toBe(2);
    expect(r.source.nominatim_rate_limit_per_sec).toBe('db');
  });

  it('rate limit ignores non-positive DB values and falls through', () => {
    const r = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        nominatim_rate_limit_per_sec: 0,
      },
      { MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: '7' },
    );
    expect(r.nominatim_rate_limit_per_sec).toBe(7);
    expect(r.source.nominatim_rate_limit_per_sec).toBe('env');
  });

  it('rate limit ignores garbage env values and uses default', () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: 'not-a-number',
    });
    expect(r.nominatim_rate_limit_per_sec).toBe(10);
    expect(r.source.nominatim_rate_limit_per_sec).toBe('default');
  });

  it('rate limit DB null falls through to env', () => {
    const r = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        nominatim_rate_limit_per_sec: null,
      },
      { MAPLE_NOMINATIM_RATE_LIMIT_PER_SEC: '3' },
    );
    expect(r.nominatim_rate_limit_per_sec).toBe(3);
    expect(r.source.nominatim_rate_limit_per_sec).toBe('env');
  });

  it('meilisearch_url falls back to env when no DB row', () => {
    const r = resolveEnrichmentConfig(null, {
      MAPLE_MEILISEARCH_URL: 'http://meili.lan:7700',
    });
    expect(r.meilisearch_url).toBe('http://meili.lan:7700');
    expect(r.source.meilisearch_url).toBe('env');
  });

  it('meilisearch_url DB wins over env', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, meilisearch_url: 'http://db.lan:7700' },
      { MAPLE_MEILISEARCH_URL: 'http://env.lan:7700' },
    );
    expect(r.meilisearch_url).toBe('http://db.lan:7700');
    expect(r.source.meilisearch_url).toBe('db');
  });

  it('meilisearch_url is null/unset when neither DB nor env set it', () => {
    const r = resolveEnrichmentConfig(null, {});
    expect(r.meilisearch_url).toBeNull();
    expect(r.source.meilisearch_url).toBe('unset');
  });

  it('meilisearch_url DB null/empty falls through to env', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, meilisearch_url: '   ' },
      { MAPLE_MEILISEARCH_URL: 'http://env.lan:7700' },
    );
    expect(r.meilisearch_url).toBe('http://env.lan:7700');
    expect(r.source.meilisearch_url).toBe('env');
  });

  it('meilisearch_api_key resolves DB > env > unset', () => {
    expect(resolveEnrichmentConfig(null, {}).meilisearch_api_key).toBeNull();
    expect(resolveEnrichmentConfig(null, {}).source.meilisearch_api_key).toBe('unset');

    const envOnly = resolveEnrichmentConfig(null, { MAPLE_MEILISEARCH_API_KEY: 'env-key' });
    expect(envOnly.meilisearch_api_key).toBe('env-key');
    expect(envOnly.source.meilisearch_api_key).toBe('env');

    const dbWins = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, meilisearch_api_key: 'db-key' },
      { MAPLE_MEILISEARCH_API_KEY: 'env-key' },
    );
    expect(dbWins.meilisearch_api_key).toBe('db-key');
    expect(dbWins.source.meilisearch_api_key).toBe('db');
  });

  it('meilisearch task timeout resolves DB value or safe default', () => {
    const defaultConfig = resolveEnrichmentConfig(null, {});
    expect(defaultConfig.meilisearch_task_timeout_seconds).toBe(
      DEFAULT_MEILISEARCH_TASK_TIMEOUT_SECONDS,
    );
    expect(defaultConfig.source.meilisearch_task_timeout_seconds).toBe('default');

    const dbConfig = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        meilisearch_task_timeout_seconds: 900,
      },
      {},
    );
    expect(dbConfig.meilisearch_task_timeout_seconds).toBe(900);
    expect(dbConfig.source.meilisearch_task_timeout_seconds).toBe('db');
  });

  it('semantic search defaults off with built-in runtime values', () => {
    const r = resolveEnrichmentConfig(null, {});
    expect(r.meilisearch_semantic_enabled).toBe(false);
    expect(r.meilisearch_embedder_url).toBe(DEFAULT_MEILISEARCH_EMBEDDER_URL);
    expect(r.meilisearch_embedder_model).toBe(DEFAULT_MEILISEARCH_EMBEDDER_MODEL);
    expect(r.meilisearch_semantic_ratio).toBe(DEFAULT_MEILISEARCH_SEMANTIC_RATIO);
    expect(r.source.meilisearch_semantic_enabled).toBe('default');
    expect(r.source.meilisearch_embedder_model).toBe('default');
  });

  it('reuses the Describe Ollama URL for semantic settings and rejects an invalid ratio', () => {
    const configured = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        describe_provider: 'ollama',
        describe_provider_url: 'http://ollama.lan:11434',
        meilisearch_semantic_enabled: true,
        meilisearch_embedder_url: 'http://stale-legacy-url:11434',
        meilisearch_embedder_model: 'custom-embedder',
        meilisearch_semantic_ratio: 0.7,
      },
      {},
    );
    expect(configured.meilisearch_semantic_enabled).toBe(true);
    expect(configured.meilisearch_embedder_url).toBe('http://ollama.lan:11434');
    expect(configured.meilisearch_embedder_model).toBe('custom-embedder');
    expect(configured.meilisearch_semantic_ratio).toBe(0.7);
    expect(configured.source.meilisearch_semantic_enabled).toBe('db');
    expect(configured.source.meilisearch_embedder_url).toBe('db');
    expect(configured.source.meilisearch_embedder_model).toBe('db');
    expect(configured.source.meilisearch_semantic_ratio).toBe('db');

    const paidDescribeProvider = resolveEnrichmentConfig(
      {
        nominatim_url: null,
        geocode_worker_enabled: true,
        describe_provider: 'openai',
        describe_provider_url: 'http://remote-ollama.lan:11434',
      },
      {},
    );
    expect(paidDescribeProvider.describe_provider_url).toBe('http://remote-ollama.lan:11434');
    expect(paidDescribeProvider.meilisearch_embedder_url).toBe('http://remote-ollama.lan:11434');
    expect(paidDescribeProvider.source.meilisearch_embedder_url).toBe('db');

    const invalid = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, meilisearch_semantic_ratio: 2 },
      {},
    );
    expect(invalid.meilisearch_semantic_ratio).toBe(DEFAULT_MEILISEARCH_SEMANTIC_RATIO);
    expect(invalid.source.meilisearch_semantic_ratio).toBe('default');
  });

  it('face_min_detection_size defaults to 0.06 when no DB row', () => {
    const r = resolveEnrichmentConfig(null, {});
    expect(r.face_min_detection_size).toBeCloseTo(0.06);
    expect(r.source.face_min_detection_size).toBe('default');
  });

  it('face_min_detection_size DB row wins over default', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, face_min_detection_size: 0.1 },
      {},
    );
    expect(r.face_min_detection_size).toBeCloseTo(0.1);
    expect(r.source.face_min_detection_size).toBe('db');
  });

  it('face_min_detection_size accepts 0 to disable the filter', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, face_min_detection_size: 0 },
      {},
    );
    expect(r.face_min_detection_size).toBe(0);
    expect(r.source.face_min_detection_size).toBe('db');
  });

  it('face_min_detection_size DB null falls through to default', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, face_min_detection_size: null },
      {},
    );
    expect(r.face_min_detection_size).toBeCloseTo(0.06);
    expect(r.source.face_min_detection_size).toBe('default');
  });

  it('face_min_detection_size rejects DB value >= 1 (falls through to default)', () => {
    const r = resolveEnrichmentConfig(
      { nominatim_url: null, geocode_worker_enabled: true, face_min_detection_size: 1 },
      {},
    );
    expect(r.face_min_detection_size).toBeCloseTo(0.06);
    expect(r.source.face_min_detection_size).toBe('default');
  });
});

describe('saveEnrichmentConfig + loadEnrichmentConfig — Mongo round-trip', () => {
  it('returns null before any save', async () => {
    if (!mongoReachable) return;
    const c = await loadEnrichmentConfig();
    expect(c).toBeNull();
  });

  it('save then load round-trips both fields', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: 'http://nominatim.test:8080',
      geocode_worker_enabled: true,
    });
    const c = await loadEnrichmentConfig();
    expect(c).toMatchObject({
      nominatim_url: 'http://nominatim.test:8080',
      geocode_worker_enabled: true,
    });
    expect(typeof c!.updated_at).toBe('number');
  });

  it('partial save preserves existing fields', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: 'http://a.test',
      geocode_worker_enabled: true,
    });
    await saveEnrichmentConfig({ geocode_worker_enabled: false });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_url).toBe('http://a.test');
    expect(c!.geocode_worker_enabled).toBe(false);
  });

  it('can clear the URL by saving null', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: 'http://x',
      geocode_worker_enabled: true,
    });
    await saveEnrichmentConfig({ nominatim_url: null });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_url).toBeNull();
  });

  it('partial save persists rate-limit and preserves URL', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: 'http://saved.lan',
      geocode_worker_enabled: true,
    });
    await saveEnrichmentConfig({ nominatim_rate_limit_per_sec: 4 });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_url).toBe('http://saved.lan');
    expect(c!.nominatim_rate_limit_per_sec).toBe(4);
  });

  it('can clear the rate limit by saving null', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: 'http://saved.lan',
      geocode_worker_enabled: true,
      nominatim_rate_limit_per_sec: 4,
    });
    await saveEnrichmentConfig({ nominatim_rate_limit_per_sec: null });
    const c = await loadEnrichmentConfig();
    expect(c!.nominatim_rate_limit_per_sec).toBeNull();
  });

  it('meilisearch task timeout round-trips through save/load', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({ meilisearch_task_timeout_seconds: 900 });
    expect((await loadEnrichmentConfig())!.meilisearch_task_timeout_seconds).toBe(900);
  });

  it('semantic search settings round-trip through save/load', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      meilisearch_semantic_enabled: true,
      meilisearch_embedder_model: 'custom-embedder',
      meilisearch_semantic_ratio: 0.65,
    });
    expect(await loadEnrichmentConfig()).toMatchObject({
      meilisearch_semantic_enabled: true,
      meilisearch_embedder_model: 'custom-embedder',
      meilisearch_semantic_ratio: 0.65,
    });
  });

  it('maps legacy face_retinaface_* / face_mobilefacenet_* onto new keys at write time', async () => {
    if (!mongoReachable) return;
    // Operator UI still POSTs the v1 names. Without the remap, the new
    // keys would stay unset and the resolver's fallback would pick the
    // legacy field at read time — but it still wouldn't show up in
    // /settings/enrichment under the new field name, so the operator
    // can't see what was saved. The remap normalises to the new schema.
    await saveEnrichmentConfig({
      face_retinaface_url: 'http://legacy.lan/scrfd_10g.onnx',
      face_retinaface_sha256: 'deadbeef',
      face_mobilefacenet_url: 'http://legacy.lan/arcface.onnx',
      face_mobilefacenet_sha256: 'cafef00d',
    });
    const c = await loadEnrichmentConfig();
    expect(c!.face_detector_url).toBe('http://legacy.lan/scrfd_10g.onnx');
    expect(c!.face_detector_sha256).toBe('deadbeef');
    expect(c!.face_recognizer_url).toBe('http://legacy.lan/arcface.onnx');
    expect(c!.face_recognizer_sha256).toBe('cafef00d');
  });

  it('new keys take precedence when both legacy and new are in one save', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      face_detector_url: 'http://new.lan/scrfd_10g.onnx',
      face_retinaface_url: 'http://legacy.lan/scrfd_10g.onnx',
      face_recognizer_url: 'http://new.lan/arcface.onnx',
      face_mobilefacenet_url: 'http://legacy.lan/arcface.onnx',
    });
    const c = await loadEnrichmentConfig();
    expect(c!.face_detector_url).toBe('http://new.lan/scrfd_10g.onnx');
    expect(c!.face_recognizer_url).toBe('http://new.lan/arcface.onnx');
  });

  it('face_min_detection_size round-trips through save/load', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: null,
      geocode_worker_enabled: true,
      face_min_detection_size: 0.08,
    });
    const c = await loadEnrichmentConfig();
    expect(c!.face_min_detection_size).toBeCloseTo(0.08);
  });

  it('can clear face_min_detection_size back to null', async () => {
    if (!mongoReachable) return;
    await saveEnrichmentConfig({
      nominatim_url: null,
      geocode_worker_enabled: true,
      face_min_detection_size: 0.08,
    });
    await saveEnrichmentConfig({ face_min_detection_size: null });
    const c = await loadEnrichmentConfig();
    expect(c!.face_min_detection_size).toBeNull();
  });
});
