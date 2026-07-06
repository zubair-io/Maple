import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { ImageDoc } from '../run-stage.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';
import type {
  MeilisearchClient,
  MeilisearchAssetDoc,
} from '../../enrichment/meilisearch-client.ts';

import { meiliHandler, setMeilisearchClientForTests } from './meili.ts';

function fakeDoc(overrides: Partial<ImageDoc> = {}): ImageDoc {
  const folderId = new ObjectId();
  return {
    _id: new ObjectId(),
    fileinfo: [{ library_id: folderId, path: '', filename: 'test.dng', deleted_at: null }],
    // maple_id is an IndexerAssetFields extension; cast through unknown for test setup.
    ...({ maple_id: 'maple-abc-123' } as unknown as Partial<ImageDoc>),
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: '2024-06-01T12:00:00.000Z',
      captured_year: 2024,
      captured_month: 6,
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps: null,
    },
    faces: [],
    description: 'A red bicycle',
    // ocr_text is on AssetDoc; cast through unknown for test setup.
    ...({ ocr_text: 'BIKE SHOP' } as unknown as Partial<ImageDoc>),
    place: {
      source: 'nominatim',
      geocoder_version: 1,
      geocoded_at: '2024-06-01T00:00:00.000Z',
      lat: 42.65,
      lon: -73.75,
      display_name: 'Albany',
      address: {},
      pois: [],
      rollups: { locality: 'Albany', region: 'NY', country_code: 'us' },
      search_blob: 'albany ny',
    },
    stages: {},
    ...overrides,
  } as ImageDoc;
}

function capturingClient(): {
  client: MeilisearchClient;
  upserts: MeilisearchAssetDoc[];
} {
  const upserts: MeilisearchAssetDoc[] = [];
  const client: MeilisearchClient = {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async (doc) => {
      upserts.push(doc);
    },
    upsertOrThrow: async (doc) => {
      upserts.push(doc);
    },
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
  return { client, upserts };
}

function failingClient(): MeilisearchClient {
  return {
    isConfigured: () => true,
    semanticConfigured: () => false,
    health: async () => true,
    ensureIndex: async () => {},
    upsert: async () => {
      throw new Error('simulated meili failure');
    },
    upsertOrThrow: async () => {
      throw new Error('simulated meili failure');
    },
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

function unconfiguredClient(): MeilisearchClient {
  return {
    isConfigured: () => false,
    semanticConfigured: () => false,
    health: async () => false,
    ensureIndex: async () => {},
    upsert: async () => {},
    upsertOrThrow: async () => {
      throw new Error('meilisearch: not configured');
    },
    tombstone: async () => {},
    search: async () => ({ ids: [], estimatedTotal: 0 }),
  };
}

const fakeCtx = {} as never;

afterEach(() => {
  setMeilisearchClientForTests(null);
});

describe('meiliHandler — upsert payload shape', () => {
  it('returns patch.search_blob and upserts with correct id, folderId, capturedAt, searchBlob, description, ocrText', async () => {
    const { client, upserts } = capturingClient();
    setMeilisearchClientForTests(client);
    const doc = fakeDoc();
    const result = await meiliHandler(doc, fakeCtx);
    // Returns patch with search_blob for Mongo $text fallback.
    const patch = (result as { patch: { search_blob: string } }).patch;
    expect(typeof patch.search_blob).toBe('string');
    // Also upserted to Meilisearch.
    expect(upserts.length).toBe(1);
    const u = upserts[0]!;
    expect(u.id).toBe('maple-abc-123');
    expect(u.folderId).toBe(doc.fileinfo![0]!.library_id.toHexString());
    expect(u.capturedAt).toBe('2024-06-01T12:00:00.000Z');
    expect(u.deletedAt).toBeNull();
    expect(u.description).toBe('A red bicycle');
    expect(u.ocrText).toBe('BIKE SHOP');
    // Unified blob must include tokens from all three sources.
    const tokens = u.searchBlob.split(' ');
    expect(tokens).toContain('albany'); // place
    expect(tokens).toContain('bicycle'); // description
    expect(tokens).toContain('bike'); // OCR
    expect(tokens).toContain('shop'); // OCR
    // Blob is sorted + deduped.
    expect(tokens).toEqual([...tokens].sort());
    expect(new Set(tokens).size).toBe(tokens.length);
    // No vision on this fixture — discrete fields default to null so the
    // index document is well-formed for assets that haven't been
    // through the describe stage yet.
    expect(u.visionSceneType).toBeNull();
    expect(u.visionActivity).toBeNull();
    expect(u.visionSubjects).toBeNull();
    expect(u.isScreenshot).toBeNull();
  });

  it('fans vision.scene_type / activity / subjects into discrete upsert fields', async () => {
    const { client, upserts } = capturingClient();
    setMeilisearchClientForTests(client);
    const doc = {
      ...fakeDoc(),
      ...({
        vision: {
          caption: 'kids playing lacrosse',
          subjects: ['person', 'child', 'athlete'],
          scene_type: 'outdoor',
          setting: 'sports field',
          activity: 'lacrosse',
          time_of_day: 'afternoon',
          lighting: 'natural',
          weather: 'clear',
          mood: 'energetic',
          colors: ['green', 'white'],
          composition: 'wide shot',
          text_visible: null,
          notable_objects: ['lacrosse stick'],
          shot_type: 'action',
          is_screenshot: false,
          nudity: 'none',
        },
        is_screenshot: false,
      } as unknown as Partial<ImageDoc>),
    } as ImageDoc;
    await meiliHandler(doc, fakeCtx);
    expect(upserts.length).toBe(1);
    const u = upserts[0]!;
    expect(u.visionSceneType).toBe('outdoor');
    expect(u.visionActivity).toBe('lacrosse');
    expect(u.visionSubjects).toEqual(['person', 'child', 'athlete']);
    expect(u.isScreenshot).toBe(false);
  });

  it('forwards is_screenshot: true to the upsert payload', async () => {
    const { client, upserts } = capturingClient();
    setMeilisearchClientForTests(client);
    const doc = {
      ...fakeDoc(),
      ...({ is_screenshot: true } as unknown as Partial<ImageDoc>),
    } as ImageDoc;
    await meiliHandler(doc, fakeCtx);
    expect(upserts.length).toBe(1);
    expect(upserts[0]!.isScreenshot).toBe(true);
  });
});

describe('meiliHandler — no maple_id', () => {
  it("returns { skip: 'no-maple-id' } and skips the upsert when maple_id is absent", async () => {
    const { client, upserts } = capturingClient();
    setMeilisearchClientForTests(client);
    // Override to drop maple_id — cast through unknown since it's not on ImageDoc's
    // base type (it's an IndexerAssetFields extension).
    const doc = {
      ...fakeDoc(),
      ...({ maple_id: undefined } as unknown as Partial<ImageDoc>),
    } as ImageDoc;
    const result = await meiliHandler(doc, fakeCtx);
    expect((result as { skip: string }).skip).toBe('no-maple-id');
    expect(upserts.length).toBe(0);
  });
});

describe('meiliHandler — Meilisearch error tolerance', () => {
  it('Meilisearch upsert failure results in handler throw so runtime retries', async () => {
    setMeilisearchClientForTests(failingClient());
    const doc = fakeDoc();
    await expect(meiliHandler(doc, fakeCtx)).rejects.toThrow('simulated meili failure');
  });
});

describe('meiliHandler — unconfigured Meilisearch', () => {
  it('still returns patch.search_blob even when Meilisearch is not configured', async () => {
    setMeilisearchClientForTests(unconfiguredClient());
    const doc = fakeDoc();
    const result = await meiliHandler(doc, fakeCtx);
    const patch = (result as { patch: { search_blob: string } }).patch;
    expect(typeof patch.search_blob).toBe('string');
    // Blob includes tokens from all three sources.
    const tokens = patch.search_blob.split(' ');
    expect(tokens).toContain('albany');
  });
});

describe('resolveAssetPeopleNames + people in the doc/blob', () => {
  // A fake person row set keyed by hex id. The mocked peopleCollection's
  // find() filters by `_id $in` and `merged_into: null`, mirroring the real
  // query shape closely enough to exercise the exclusion logic.
  const PERSON_A = new ObjectId();
  const PERSON_AUTO = new ObjectId();
  const PERSON_MERGED = new ObjectId();
  const personRows = [
    { _id: PERSON_A, name: 'Greyson', merged_into: null },
    // Auto-generated cluster name — must be excluded from the index.
    { _id: PERSON_AUTO, name: 'Person 7', merged_into: null },
    // Merged row — must be excluded.
    { _id: PERSON_MERGED, name: 'Maya', merged_into: new ObjectId() },
  ];

  function facesFor(...ids: ObjectId[]): AssetFaceDoc[] {
    return ids.map((id) => ({
      bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
      person_id: id.toHexString(),
      confidence: 0.99,
    }));
  }

  it('folds named people into the doc + blob, excluding Person N and merged', async () => {
    const realDbClient = await import('../../db/client.ts');
    const dbSpy = spyOn(realDbClient, 'peopleCollection').mockImplementation(async () => {
      return {
        find: (filter: { _id: { $in: ObjectId[] }; merged_into: null }) => {
          const idSet = new Set(filter._id.$in.map((o) => o.toHexString()));
          const matched = personRows.filter(
            (r) => idSet.has(r._id.toHexString()) && r.merged_into === null,
          );
          return {
            project: () => ({
              toArray: async () => matched.map((r) => ({ name: r.name })),
            }),
          };
        },
      } as any;
    });
    try {
      const { client, upserts } = capturingClient();
      setMeilisearchClientForTests(client);
      const doc = {
        ...fakeDoc(),
        faces: facesFor(PERSON_A, PERSON_AUTO, PERSON_MERGED),
      } as ImageDoc;
      const result = await meiliHandler(doc, fakeCtx);
      expect(upserts.length).toBe(1);
      const u = upserts[0]!;
      // Only the real, live, non-auto name lands in the doc.
      expect(u.people).toEqual(['Greyson']);
      // …and in the unified blob.
      expect(u.searchBlob.split(' ')).toContain('greyson');
      // The patch blob (Mongo fallback) carries it too.
      const patch = (result as { patch: { search_blob: string } }).patch;
      expect(patch.search_blob.split(' ')).toContain('greyson');
      setMeilisearchClientForTests(null);
    } finally {
      dbSpy.mockRestore();
    }
  });
});

describe('meiliHandler — null enrichment fields', () => {
  it('produces a valid (possibly empty) blob when description and ocr_text are null', async () => {
    const { client, upserts } = capturingClient();
    setMeilisearchClientForTests(client);
    const doc = {
      ...fakeDoc(),
      description: null,
      ...({ ocr_text: null } as unknown as Partial<ImageDoc>),
    } as ImageDoc;
    await meiliHandler(doc, fakeCtx);
    expect(upserts.length).toBe(1);
    const blob = upserts[0]!.searchBlob;
    // Place tokens still contribute.
    expect(blob.split(' ')).toContain('albany');
  });
});
