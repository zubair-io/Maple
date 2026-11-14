/**
 * RAW+JPEG stacks in the service photo API. A filter-only search folds the JPEG into its RAW. A
 * text search keeps the JPEG when only the JPEG matched the text (`foldRankedStacks`), and that
 * survivor must reach `photos`, `total`, `days` and the single-photo endpoint alike.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { run } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { setInProcessSearchForTests } from '../src/search/search-pool.ts';
import { fakeInProcessSearch } from '../src/search/search.test-helpers.ts';
import {
  createServiceFixture,
  search,
  serviceRequest,
  type ServiceFixture,
} from './helpers/service-photos-fixtures.ts';

let fx: ServiceFixture;
let raw: string;
let jpeg: string;

beforeEach(async () => {
  fx = await createServiceFixture();
  setInProcessSearchForTests(fakeInProcessSearch(null));
  const capturedAt = '2024-07-04T10:00:00.000Z';
  raw = fx.photo({ filename: 'IMG_0001.dng', path: '', capturedAt, searchBlob: 'forest' });
  jpeg = fx.photo({ filename: 'IMG_0001.jpg', path: '', capturedAt, searchBlob: 'lighthouse' });
  run(fx.live.db, 'UPDATE assets SET stack_primary_id = ? WHERE id = ?', raw, jpeg);
});

afterEach(() => {
  setInProcessSearchForTests(null);
  fx.close();
});

describe('RAW+JPEG stacks', () => {
  it('folds the JPEG into its RAW when no text is searched', async () => {
    const result = await search(fx.key, { from: '2024-07-04', to: '2024-07-04' });
    expect(result.body.photos.map((photo) => photo.assetId)).toEqual([raw]);
    expect(result.body.total).toBe(1);
  });

  it('keeps a JPEG that alone matched the text, consistently across the response', async () => {
    for (const body of [
      { query: 'lighthouse' },
      { query: 'lighthouse', from: '2024-07-04', to: '2024-07-04' },
    ]) {
      const result = await search(fx.key, body);
      expect(result.body.total).toBe(1);
      expect(result.body.photos.map((photo) => photo.assetId)).toEqual([jpeg]);
      expect(result.body.days).toEqual([{ date: '2024-07-04', count: 1, place: null }]);
    }
    expect((await serviceRequest(`/photos/${jpeg}`, fx.key)).status).toBe(200);
  });
});
