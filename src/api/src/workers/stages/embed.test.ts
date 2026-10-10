import { afterEach, describe, expect, it } from 'bun:test';
import { ObjectId } from '../../db/object-id.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { insertPerson } from '../../db/repos/people.test-helpers.ts';
import { EMBEDDER_TEMPLATE_SHAPE_VERSION } from '../../enrichment/meilisearch-embedder-template.ts';
import { decodeVector, l2Normalize } from '../../enrichment/ollama-embed-client.ts';
import { forgetEmbedderTarget } from '../embed/embedder-target.ts';
import embedStage, {
  embedHandler,
  rearmForEmbedderTarget,
  setEmbedBatchForTests,
} from './embed.ts';
import { WorkerConfigRepo } from '../../db/repos/worker-config.repo.ts';
import { seedClaimableAsset, stageRow } from '../../db/repos/stage-runtime.test-helpers.ts';

const fakeCtx = { log: console as never, signal: new AbortController().signal };

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

function recordingEmbedder(): { inputs: string[][] } {
  const recorded: { inputs: string[][] } = { inputs: [] };
  setEmbedBatchForTests(async (_target, inputs) => {
    recorded.inputs.push([...inputs]);
    return inputs.map((_, index) => l2Normalize([index + 1, 2, 2]));
  });
  return recorded;
}

afterEach(() => {
  setEmbedBatchForTests(null);
  forgetEmbedderTarget();
});

describe('embedHandler', () => {
  it('embeds the rendered template and writes a normalised little-endian f32 vector', async () => {
    using live = await createLiveTestDatabase();
    const recorded = recordingEmbedder();
    const assetId = seedClaimableAsset(live.db, {
      stages: { embed: { nextAttemptAt: '2026-10-09T00:10:00.000Z' } },
    });

    const result = await embedHandler(fakeDoc({ _id: new ObjectId(assetId) }), fakeCtx);
    if (!('patch' in result)) throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
    await live.handle.transaction(result.patch);

    expect(recorded.inputs).toEqual([
      ['Filename: IMG_0001.jpg\nMedia type: image\n\n\nVisual description: A red bicycle\n\nOCR: '],
    ]);
    const row = live.db.query(`SELECT * FROM asset_vectors`).get() as {
      maple_id: string;
      version: number;
      model: string;
      dims: number;
      vector: Uint8Array;
    };
    expect(row).toMatchObject({
      maple_id: 'maple-abc-123',
      version: EMBEDDER_TEMPLATE_SHAPE_VERSION,
      model: 'bge-m3',
      dims: 3,
    });
    const stored = decodeVector(row.vector);
    expect(Math.hypot(...stored)).toBeCloseTo(1, 6);
  });

  it('shares one Ollama call between assets handled at the same time', async () => {
    const recorded = recordingEmbedder();

    const results = await Promise.all(
      ['a', 'b', 'c'].map((id) => embedHandler(fakeDoc({ maple_id: id }), fakeCtx)),
    );

    expect(recorded.inputs).toHaveLength(1);
    expect(recorded.inputs[0]).toHaveLength(3);
    expect(results.every((result) => 'patch' in result)).toBe(true);
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
  it('is gated on the embedder template version and starts paused', () => {
    expect(embedStage.targetVersion).toBe(EMBEDDER_TEMPLATE_SHAPE_VERSION);
    expect(embedStage.defaults.pausedOnFirstBoot).toBe(true);
    expect(embedStage.dependsOn).toEqual(['exif']);
  });
});

describe('rearmForEmbedderTarget', () => {
  const target = { url: 'http://gpu:11434', model: 'bge-m3' };

  it('revives dead-lettered assets once per embedder target, not on every sweep', async () => {
    using live = await createLiveTestDatabase();
    const dead = seedClaimableAsset(live.db, {
      stages: { embed: { version: 0, attempts: 3, dead: true } },
    });

    await rearmForEmbedderTarget(target);
    expect(stageRow(live.db, dead, 'embed')?.dead).toBe(0);
    expect((await new WorkerConfigRepo().load('embed'))?.ai_model).toBe(
      'bge-m3 @ http://gpu:11434',
    );

    live.db.run(`UPDATE stage_state SET dead = 1 WHERE asset_id = ? AND stage = 'embed'`, [dead]);
    await rearmForEmbedderTarget(target);
    expect(stageRow(live.db, dead, 'embed')?.dead).toBe(1);

    await rearmForEmbedderTarget({ ...target, model: 'other-model' });
    expect(stageRow(live.db, dead, 'embed')?.dead).toBe(0);
  });
});
