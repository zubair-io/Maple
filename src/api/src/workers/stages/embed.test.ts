import { afterEach, describe, expect, it } from 'bun:test';
import { ObjectId } from '../../db/object-id.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import { runStage } from '../run-stage.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { insertPerson } from '../../db/repos/people.test-helpers.ts';
import { EMBEDDER_TEMPLATE_SHAPE_VERSION } from '../../enrichment/embedder-document.ts';
import { decodeVector } from '../../enrichment/vector-codec.ts';
import embedStage, { embedHandler, setEmbedBatchForTests } from './embed.ts';
import { rearmForBundledEmbedder, sweepEmbedderChange } from '../embed/embedder-rearm.ts';
import { BUNDLED_EMBEDDER } from '../embed/local-embedder.ts';
import { upsertAssetVectorStatement } from '../../db/repos/asset-vectors.repo.ts';
import { WorkerConfigRepo } from '../../db/repos/worker-config.repo.ts';
import { seedClaimableAsset, stageRow } from '../../db/repos/stage-runtime.test-helpers.ts';
import { insertStageState } from '../../db/repos/assets.test-helpers.ts';
import { loadAllVectors } from '../../search/search-index-sync.ts';
import { SEARCH_EMBEDDING_MODEL } from '../../db/repos/asset-vectors.search.ts';
import { RecordingEngine } from '../../search/search.test-helpers.ts';
import type { EmbedOutcome } from '../../search/search-protocol.ts';

const LEASE = '2026-10-09T00:10:00.000Z';
const fakeCtx = { log: console as never, signal: new AbortController().signal, lease: LEASE };

function fakeDoc(overrides: Record<string, unknown> = {}): ImageDoc {
  return {
    _id: new ObjectId(),
    fileinfo: [
      { library_id: new ObjectId(), path: '', filename: 'IMG_0001.jpg', deleted_at: null },
    ],
    maple_id: 'maple-abc-123',
    faces: [],
    description: 'A red bicycle',
    ocr_text: '',
    transcript: null,
    place: null,
    ...overrides,
  } as unknown as ImageDoc;
}

function unit(axis: number, dims = 3): Float32Array {
  return Float32Array.from({ length: dims }, (_, index) => (index === axis ? 1 : 0));
}

function recordingEmbedder(answer?: (texts: readonly string[]) => EmbedOutcome): {
  inputs: string[][];
} {
  const recorded: { inputs: string[][] } = { inputs: [] };
  setEmbedBatchForTests(async (texts) => {
    recorded.inputs.push([...texts]);
    return answer?.(texts) ?? { ok: true, vectors: texts.map((_, index) => unit(index % 3)) };
  });
  return recorded;
}

afterEach(() => {
  setEmbedBatchForTests(null);
});

describe('embedHandler', () => {
  it('embeds the rendered template and writes a bundled bge-m3 vector', async () => {
    using live = await createLiveTestDatabase();
    const recorded = recordingEmbedder();
    const assetId = seedClaimableAsset(live.db, {
      stages: { embed: { claimToken: LEASE, nextAttemptAt: LEASE } },
    });

    const result = await embedHandler(fakeDoc({ _id: new ObjectId(assetId) }), fakeCtx);
    if (!('patch' in result)) throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
    await live.handle.transaction(result.patch);

    expect(recorded.inputs).toEqual([
      ['Filename: IMG_0001.jpg\nMedia type: image\n\n\nVisual description: A red bicycle\n\nOCR: '],
    ]);
    const row = live.db.query(`SELECT * FROM asset_vectors`).get() as { vector: Uint8Array };
    expect(row).toMatchObject({
      maple_id: 'maple-abc-123',
      version: EMBEDDER_TEMPLATE_SHAPE_VERSION,
      model: 'bge-m3',
      endpoint: 'bundled',
      dims: 3,
    });
    expect(Array.from(decodeVector(row.vector))).toEqual([1, 0, 0]);
  });

  it('shares one engine call between assets handled at the same time', async () => {
    const recorded = recordingEmbedder();

    const results = await Promise.all(
      ['a', 'b', 'c'].map((id) => embedHandler(fakeDoc({ maple_id: id }), fakeCtx)),
    );

    expect(recorded.inputs).toHaveLength(1);
    expect(recorded.inputs[0]).toHaveLength(3);
    expect(results.every((result) => 'patch' in result)).toBe(true);
  });

  it('defers, without spending a retry, while the search engine cannot embed yet', async () => {
    recordingEmbedder(() => ({
      ok: false,
      waiting: true,
      error: 'the search engine is still loading',
    }));
    const before = Date.now();

    const result = await embedHandler(fakeDoc(), fakeCtx);

    if (!('defer' in result)) throw new Error(`expected a deferral, got ${JSON.stringify(result)}`);
    expect(result.defer.reason).toBe('the search engine is still loading');
    expect(result.defer.retryAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
  });

  it('fails the attempt when the engine reports an error', async () => {
    recordingEmbedder(() => ({ ok: false, waiting: false, error: 'tokenizer failed' }));
    await expect(embedHandler(fakeDoc(), fakeCtx)).rejects.toThrow('embed: tokenizer failed');
  });

  it('renders named people with no separator', async () => {
    using live = await createLiveTestDatabase();
    const zoe = insertPerson(live.db, { name: 'Zoe' });
    const greyson = insertPerson(live.db, { name: 'Greyson' });
    const faces: AssetFaceDoc[] = [zoe, greyson].map((person_id) => ({
      bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
      person_id,
      confidence: 0.99,
    }));
    const recorded = recordingEmbedder();

    await embedHandler(fakeDoc({ faces }), fakeCtx);

    expect(recorded.inputs[0]![0]!.split('\n')[2]).toBe('People: ZoeGreyson');
  });

  it.each([
    ['no maple id', { maple_id: undefined }, 'no-maple-id'],
    ['a trashed asset', { deleted_at: '2026-10-09T00:00:00.000Z' }, 'trashed'],
    ['no live location', { fileinfo: [] }, 'no-resolvable-location'],
  ])('skips %s without calling the embedder', async (_name, overrides, reason) => {
    const recorded = recordingEmbedder();
    const result: StageResult = await embedHandler(fakeDoc(overrides), fakeCtx);
    expect(result).toEqual({ skip: reason });
    expect(recorded.inputs).toEqual([]);
  });
});

describe('embed stage definition', () => {
  it('is gated on the embedder template version and runs from the first boot', () => {
    expect(embedStage.targetVersion).toBe(EMBEDDER_TEMPLATE_SHAPE_VERSION);
    expect(embedStage.defaults.pausedOnFirstBoot).toBe(false);
    expect(embedStage.dependsOn).toEqual(['exif']);
  });
});

describe('rearmForBundledEmbedder', () => {
  it('revives dead-lettered assets once, on the first run with the bundled model', async () => {
    using live = await createLiveTestDatabase();
    await new WorkerConfigRepo().patch('embed', { ai_model: 'bge-m3:latest @ http://gpu:11434' });
    const dead = seedClaimableAsset(live.db, {
      stages: { embed: { version: 0, attempts: 3, dead: true } },
    });

    await rearmForBundledEmbedder();
    expect(stageRow(live.db, dead, 'embed')?.dead).toBe(0);
    expect((await new WorkerConfigRepo().load('embed'))?.ai_model).toBe(BUNDLED_EMBEDDER);

    live.db.run(`UPDATE stage_state SET dead = 1 WHERE asset_id = ? AND stage = 'embed'`, [dead]);
    await rearmForBundledEmbedder();
    expect(stageRow(live.db, dead, 'embed')?.dead).toBe(1);
  });
});

describe('sweepEmbedderChange', () => {
  it('re-arms another model’s rows on the next interval even while the stage is busy', async () => {
    using live = await createLiveTestDatabase();
    const assetId = seedClaimableAsset(live.db, { stages: { embed: { version: 8 } } });
    live.db.run(`UPDATE assets SET maple_id = 'm1' WHERE id = ?`, [assetId]);
    await live.handle.transaction([
      upsertAssetVectorStatement({
        mapleId: 'm1',
        version: 8,
        model: 'nomic-embed-text',
        endpoint: 'http://localhost:11434',
        vector: Float32Array.of(1),
        embeddedAt: new Date(),
      }),
    ]);
    const start = 1_800_000_000_000;

    await sweepEmbedderChange(5, false, start);
    expect(stageRow(live.db, assetId, 'embed')?.version).toBe(0);

    live.db.run(`UPDATE stage_state SET version = 8 WHERE asset_id = ? AND stage = 'embed'`, [
      assetId,
    ]);
    await sweepEmbedderChange(5, false, start + 30_000);
    expect(stageRow(live.db, assetId, 'embed')?.version).toBe(8);

    await sweepEmbedderChange(5, false, start + 61_000);
    expect(stageRow(live.db, assetId, 'embed')?.version).toBe(0);
  });
});

const OLLAMA_ENDPOINT = 'http://192.168.0.201:11434';
const OLLAMA_EMBEDDED_AT = '2026-10-01T00:00:00.000Z';

interface VectorRow {
  maple_id: string;
  model: string;
  endpoint: string;
  embedded_at: string;
  vector: Uint8Array;
}

/** An asset whose EXIF is done, with `embed` at `version` and, optionally, a stored vector. */
async function libraryAsset(
  live: LiveTestDatabase,
  mapleId: string,
  embedded: { axis: number } | null,
): Promise<string> {
  const assetId = seedClaimableAsset(live.db, {
    stages: { exif: { version: 1_000 }, embed: { version: embedded ? 8 : 0 } },
  });
  live.db.run(`UPDATE assets SET maple_id = ? WHERE id = ?`, [mapleId, assetId]);
  if (embedded) {
    insertStageState(live.db, assetId, 'embed', {
      version: EMBEDDER_TEMPLATE_SHAPE_VERSION,
      processedAt: OLLAMA_EMBEDDED_AT,
    });
    await live.handle.transaction([
      upsertAssetVectorStatement({
        mapleId,
        version: EMBEDDER_TEMPLATE_SHAPE_VERSION,
        model: 'bge-m3:latest',
        endpoint: OLLAMA_ENDPOINT,
        vector: unit(embedded.axis, 1024),
        embeddedAt: new Date(OLLAMA_EMBEDDED_AT),
      }),
    ]);
  }
  return assetId;
}

function vectorRows(live: LiveTestDatabase): VectorRow[] {
  return live.db
    .query(
      `SELECT maple_id, model, endpoint, embedded_at, vector FROM asset_vectors ORDER BY maple_id`,
    )
    .all() as VectorRow[];
}

async function searchableVectors(): Promise<Map<string, number>> {
  const engine = new RecordingEngine();
  await loadAllVectors(engine, SEARCH_EMBEDDING_MODEL);
  return engine.vectors;
}

async function until(done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await Bun.sleep(25);
  }
}

describe('switching an Ollama bge-m3 library to the bundled model', () => {
  it('re-embeds nothing Ollama already embedded, and search reads the same vectors', async () => {
    using live = await createLiveTestDatabase();
    await new WorkerConfigRepo().patch('embed', {
      ai_model: `bge-m3:latest @ ${OLLAMA_ENDPOINT}`,
      paused: false,
      concurrency: 8,
    });
    const embedded = await Promise.all(
      ['ollama-a', 'ollama-b', 'ollama-c'].map((id, axis) => libraryAsset(live, id, { axis })),
    );
    const fresh = await libraryAsset(live, 'new-photo', null);
    const rowsBefore = vectorRows(live);
    const searchBefore = await searchableVectors();
    expect([...searchBefore.keys()].sort()).toEqual(['ollama-a', 'ollama-b', 'ollama-c']);
    const recorded = recordingEmbedder((texts) => ({
      ok: true,
      vectors: texts.map(() => unit(3, 1024)),
    }));

    const stage = await runStage(embedStage);
    try {
      await until(
        () => stageRow(live.db, fresh, 'embed')?.version === EMBEDDER_TEMPLATE_SHAPE_VERSION,
      );
      await rearmForBundledEmbedder();
    } finally {
      await stage.stop();
    }

    expect(recorded.inputs.flat()).toHaveLength(1);
    for (const assetId of embedded) {
      expect(stageRow(live.db, assetId, 'embed')).toMatchObject({
        version: EMBEDDER_TEMPLATE_SHAPE_VERSION,
        processed_at: OLLAMA_EMBEDDED_AT,
      });
    }
    const rowsAfter = vectorRows(live);
    expect(rowsAfter.filter((row) => row.maple_id !== 'new-photo')).toEqual(rowsBefore);
    expect(rowsAfter.find((row) => row.maple_id === 'new-photo')).toMatchObject({
      model: 'bge-m3',
      endpoint: 'bundled',
    });
    const searchAfter = await searchableVectors();
    expect(searchAfter).toEqual(new Map([...searchBefore, ['new-photo', 3]]));
    expect((await new WorkerConfigRepo().load('embed'))?.ai_model).toBe(BUNDLED_EMBEDDER);
  }, 30_000);
});
