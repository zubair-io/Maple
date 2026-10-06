import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { subjectMasksRoutes } from './subject-masks.ts';
import {
  setSubjectMaskCacheDirForTests,
  writeRasterPng,
} from '../enrichment/subject-masks/subject-mask-cache.ts';
import { PERSON_SEGMENTATION_MODEL_ID } from '../enrichment/subject-masks/person-segmenter.ts';
import { subjectMaskDigest } from '../enrichment/subject-masks/subject-mask-digest.ts';
import { run } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../db/object-id.ts';

describe('/api/subject-masks', () => {
  let live: LiveTestDatabase;
  let tmpCacheDir: string;

  beforeEach(async () => {
    live = await createLiveTestDatabase();
    tmpCacheDir = await mkdtemp(join(tmpdir(), 'subject-masks-test-'));
    setSubjectMaskCacheDirForTests(tmpCacheDir);
  });

  afterEach(async () => {
    live?.close();
    setSubjectMaskCacheDirForTests(null);
    try {
      await rm(tmpCacheDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  function app() {
    return new Elysia().use(subjectMasksRoutes);
  }

  describe('GET /api/subject-masks/persons', () => {
    it('returns 400 or 422 when asset query is missing', async () => {
      const res = await app().handle(new Request('http://localhost/api/subject-masks/persons'));
      expect([400, 422]).toContain(res.status);
    });

    it('returns 404 when no segmentation exists for the asset', async () => {
      const res = await app().handle(
        new Request('http://localhost/api/subject-masks/persons?asset=missing-asset-id'),
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toContain('No segmentation');
    });

    it('returns empty persons array when segmentation detected nobody', async () => {
      const assetId = newObjectIdHex();
      run(
        live.db,
        `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 100, 100, '2026-01-01')`,
        assetId,
      );
      run(
        live.db,
        `INSERT INTO person_segmentations (asset_id, model, persons, created_at) VALUES (?, ?, json(?), '2026-01-01')`,
        assetId,
        PERSON_SEGMENTATION_MODEL_ID,
        JSON.stringify([]),
      );

      const res = await app().handle(
        new Request(`http://localhost/api/subject-masks/persons?asset=${assetId}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.model).toBe(PERSON_SEGMENTATION_MODEL_ID);
      expect(body.persons).toEqual([]);
    });

    it('returns detected persons with bounding boxes', async () => {
      const assetId = newObjectIdHex();
      const persons = [
        {
          person: 0,
          bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        },
        {
          person: 1,
          bbox: { x: 0.5, y: 0.4, width: 0.2, height: 0.5 },
        },
      ];
      run(
        live.db,
        `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 100, 100, '2026-01-01')`,
        assetId,
      );
      run(
        live.db,
        `INSERT INTO person_segmentations (asset_id, model, persons, created_at) VALUES (?, ?, json(?), '2026-01-01')`,
        assetId,
        PERSON_SEGMENTATION_MODEL_ID,
        JSON.stringify(persons),
      );

      const res = await app().handle(
        new Request(`http://localhost/api/subject-masks/persons?asset=${assetId}`),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.model).toBe(PERSON_SEGMENTATION_MODEL_ID);
      expect(body.persons).toEqual(persons);
    });

    it('resolves assetKey when given an address (slug:relPath)', async () => {
      const libraryId = newObjectIdHex();
      const assetId = newObjectIdHex();
      run(
        live.db,
        `INSERT INTO folders (id, slug, label, path, file_count, created_at) VALUES (?, 'vacation', 'Vacation', '/lib', 1, '2026-01-01')`,
        libraryId,
      );
      run(
        live.db,
        `INSERT INTO assets (id, size, mtime, indexed_at) VALUES (?, 100, 100, '2026-01-01')`,
        assetId,
      );
      run(
        live.db,
        `INSERT INTO asset_locations (asset_id, library_id, ordinal, path, filename) VALUES (?, ?, 0, '2026', 'beach.jpg')`,
        assetId,
        libraryId,
      );
      run(
        live.db,
        `INSERT INTO person_segmentations (asset_id, model, persons, created_at) VALUES (?, ?, json(?), '2026-01-01')`,
        assetId,
        PERSON_SEGMENTATION_MODEL_ID,
        JSON.stringify([{ person: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }]),
      );

      const address = 'vacation:2026/beach.jpg';
      const res = await app().handle(
        new Request(
          `http://localhost/api/subject-masks/persons?asset=${encodeURIComponent(address)}`,
        ),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.model).toBe(PERSON_SEGMENTATION_MODEL_ID);
      expect(body.persons).toHaveLength(1);
    });
  });

  describe('GET /api/subject-masks/raster/:digest', () => {
    it('returns 404 for malformed digest', async () => {
      const res = await app().handle(
        new Request('http://localhost/api/subject-masks/raster/invalid_digest'),
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown digest', async () => {
      const digest = '0123456789abcdef';
      const res = await app().handle(
        new Request(`http://localhost/api/subject-masks/raster/${digest}`),
      );
      expect(res.status).toBe(404);
    });

    it('serves raster PNG with cache headers when found', async () => {
      const assetKey = 'asset-123';
      const digest = subjectMaskDigest(assetKey, 0, true, true, PERSON_SEGMENTATION_MODEL_ID);
      const fakePngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
      await writeRasterPng(digest, fakePngBytes);

      const res = await app().handle(
        new Request(`http://localhost/api/subject-masks/raster/${digest}`),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(res.headers.get('Cache-Control')).toContain('immutable');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes).toEqual(fakePngBytes);
    });
  });
});
