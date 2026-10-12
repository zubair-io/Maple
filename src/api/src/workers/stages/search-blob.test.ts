import { describe, it, expect } from 'bun:test';
import { ObjectId } from '../../db/object-id.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import type { AssetFaceDoc } from '../../db/schema.ts';
import { searchBlobHandler } from './search-blob.ts';
import { createLiveTestDatabase } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { insertPerson } from '../../db/repos/people.test-helpers.ts';

/** The `asset_search` upsert the handler asked the runner to run. */
function blobOf(result: StageResult): string | null {
  if (!('patch' in result)) return null;
  const upsert = result.patch.find((statement) =>
    statement.sql.includes('INSERT INTO asset_search'),
  );
  return upsert === undefined ? null : ((upsert.params as unknown[])[1] as string);
}

function fakeDoc(overrides: Partial<ImageDoc> = {}): ImageDoc {
  const folderId = new ObjectId();
  return {
    _id: new ObjectId(),
    fileinfo: [{ library_id: folderId, path: '', filename: 'test.dng', deleted_at: null }],
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

const fakeCtx = {} as never;

describe('searchBlobHandler', () => {
  it('writes a blob folding in place, description and OCR text', async () => {
    const result = await searchBlobHandler(fakeDoc(), fakeCtx);
    const tokens = blobOf(result)!.split(' ');
    expect(tokens).toContain('albany');
    expect(tokens).toContain('bicycle');
    expect(tokens).toContain('bike');
  });

  it("returns { skip: 'no-maple-id' } when maple_id is absent", async () => {
    const doc = { ...fakeDoc(), maple_id: undefined } as unknown as ImageDoc;
    expect(await searchBlobHandler(doc, fakeCtx)).toEqual({ skip: 'no-maple-id' });
  });

  it("skips a trashed asset with { skip: 'trashed' }", async () => {
    const doc = { ...fakeDoc(), deleted_at: '2026-01-01T00:00:00.000Z' } as unknown as ImageDoc;
    expect(await searchBlobHandler(doc, fakeCtx)).toEqual({ skip: 'trashed' });
  });

  it('produces a valid blob when description and ocr_text are null', async () => {
    const doc = {
      ...fakeDoc(),
      description: null,
      ...({ ocr_text: null } as unknown as Partial<ImageDoc>),
    } as ImageDoc;
    expect(blobOf(await searchBlobHandler(doc, fakeCtx))!.split(' ')).toContain('albany');
  });

  describe('named people', () => {
    const PERSON_A = new ObjectId().toHexString();
    const PERSON_AUTO = new ObjectId().toHexString();
    const PERSON_MERGED = new ObjectId().toHexString();
    const PERSON_HIDDEN = new ObjectId().toHexString();
    const PERSON_EXCLUDED = new ObjectId().toHexString();

    function facesFor(...ids: string[]): AssetFaceDoc[] {
      return ids.map((id) => ({
        bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
        person_id: id,
        confidence: 0.99,
      }));
    }

    it('folds named people into the blob, excluding Person N, merged, hidden and excluded', async () => {
      using live = await createLiveTestDatabase();
      const survivor = insertPerson(live.db, { name: 'Survivor' });
      insertPerson(live.db, { id: PERSON_A, name: 'Greyson' });
      insertPerson(live.db, { id: PERSON_AUTO, name: 'Person 7' });
      insertPerson(live.db, { id: PERSON_MERGED, name: 'Maya', mergedInto: survivor });
      insertPerson(live.db, { id: PERSON_HIDDEN, name: 'Hidden Helen', hidden: true });
      insertPerson(live.db, { id: PERSON_EXCLUDED, name: 'Excluded Edith', excluded: true });
      const doc = {
        ...fakeDoc(),
        faces: facesFor(PERSON_A, PERSON_AUTO, PERSON_MERGED, PERSON_HIDDEN, PERSON_EXCLUDED),
      } as ImageDoc;

      const tokens = blobOf(await searchBlobHandler(doc, fakeCtx))!.split(' ');

      expect(tokens).toContain('greyson');
      expect(tokens).not.toContain('edith');
      expect(tokens).not.toContain('maya');
    });
  });
});
