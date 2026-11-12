/**
 * What `mergeIntoSurvivor` carries across, against the real schema (#5090).
 *
 * A merge deletes the condemned row, and FK cascade takes everything keyed by
 * its id. These cases pin what is carried to the survivor first, the rule for
 * the cases where both rows hold the data, and that stage bookkeeping follows
 * the data.
 */
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../sqlite/test-sqlite.test-helpers.ts';
import {
  insertDetail,
  insertFaceRow,
  insertPhassetLink,
  insertStageState,
} from './assets.test-helpers.ts';
import { mergeIntoSurvivor } from './assets.merge.ts';

const SURVIVOR_ID = '01' + 'a'.repeat(30);
const CONDEMNED_ID = '02' + 'b'.repeat(30);

interface Pair {
  survivor: string;
  condemned: string;
}

function seedPair(db: Database): Pair {
  const libraryId = insertFolder(db);
  const survivor = insertAsset(db, {});
  const condemned = insertAsset(db, {});
  run(
    db,
    `UPDATE assets SET maple_id = ? WHERE id = ?`,
    SURVIVOR_ID.replace(/^01/, '02'),
    survivor,
  );
  run(db, `UPDATE assets SET maple_id = ? WHERE id = ?`, CONDEMNED_ID, condemned);
  insertLocation(db, { assetId: survivor, libraryId, ordinal: 0, path: 'a', filename: 'IMG.dng' });
  insertLocation(db, { assetId: condemned, libraryId, ordinal: 0, path: 'b', filename: 'IMG.dng' });
  return { survivor, condemned };
}

const merge = (pair: Pair): Promise<void> =>
  mergeIntoSurvivor({
    survivorId: pair.survivor,
    condemnedId: pair.condemned,
    mapleId: SURVIVOR_ID,
  });

function detail(db: Database, assetId: string): Record<string, unknown> | null {
  return db.query(`SELECT * FROM asset_detail WHERE asset_id = ?`).get(assetId) as Record<
    string,
    unknown
  > | null;
}

const faceCount = (db: Database, assetId: string): number =>
  (db.query(`SELECT COUNT(*) AS n FROM faces WHERE asset_id = ?`).get(assetId) as { n: number }).n;

function stage(db: Database, assetId: string, name: string): { version: number } | null {
  return db
    .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = ?`)
    .get(assetId, name) as { version: number } | null;
}

describe('mergeIntoSurvivor — derived data and links', () => {
  it('a loser with links, describe output, faces and place merges into a bare survivor with all of it', async () => {
    using live = await createLiveTestDatabase();
    const pair = seedPair(live.db);
    const place = JSON.stringify({ rollups: { locality: 'Lisbon' }, geocoder_version: 3 });
    run(live.db, `UPDATE assets SET place = ? WHERE id = ?`, place, pair.condemned);
    insertDetail(live.db, pair.condemned, {
      description: 'A harbour at dusk',
      descriptionMeta: '{"model":"m"}',
      ocrText: 'PORTO',
      vision: '{"scene_type":"harbour","subjects":["boat"]}',
      visionMeta: '{"v":1}',
      transcript: '{"text":"hello"}',
    });
    insertFaceRow(live.db, {
      assetId: pair.condemned,
      faceIndex: 0,
      embedding: '[0.1,0.2]',
      embeddingVersion: 'v1',
    });
    insertFaceRow(live.db, { assetId: pair.condemned, faceIndex: 1, hidden: true });
    insertPhassetLink(live.db, {
      assetId: pair.condemned,
      deviceId: 'phone',
      phassetLocalId: 'L1',
      phassetCloudId: 'C1',
    });
    insertStageState(live.db, pair.condemned, 'describe', {
      version: 9,
      processedAt: '2026-05-01T00:00:00Z',
    });
    insertStageState(live.db, pair.condemned, 'face-detect', { version: 2 });
    insertStageState(live.db, pair.condemned, 'geocode', { version: 3 });
    insertStageState(live.db, pair.survivor, 'describe', { version: 0 });
    insertStageState(live.db, pair.survivor, 'face-detect', { version: 0 });
    insertStageState(live.db, pair.survivor, 'geocode', { version: 0 });
    insertStageState(live.db, pair.survivor, 'search-blob', { version: 10 });

    await merge(pair);

    expect(live.db.query(`SELECT id FROM assets WHERE id = ?`).get(pair.condemned)).toBeNull();
    expect(detail(live.db, pair.survivor)).toMatchObject({
      description: 'A harbour at dusk',
      description_meta: '{"model":"m"}',
      ocr_text: 'PORTO',
      vision_meta: '{"v":1}',
      transcript: '{"text":"hello"}',
    });
    expect(
      live.db.query(`SELECT subject FROM asset_subjects WHERE asset_id = ?`).all(pair.survivor),
    ).toEqual([{ subject: 'boat' }]);
    expect(live.db.query(`SELECT place FROM assets WHERE id = ?`).get(pair.survivor)).toEqual({
      place,
    });
    expect(faceCount(live.db, pair.survivor)).toBe(2);
    expect(
      live.db
        .query(
          `SELECT embedding, embedding_version, hidden FROM faces WHERE asset_id = ? ORDER BY face_index`,
        )
        .all(pair.survivor),
    ).toEqual([
      { embedding: '[0.1,0.2]', embedding_version: 'v1', hidden: 0 },
      { embedding: null, embedding_version: null, hidden: 1 },
    ]);
    expect(
      live.db
        .query(
          `SELECT device_id, phasset_local_id, phasset_cloud_id FROM asset_phasset_links WHERE asset_id = ?`,
        )
        .all(pair.survivor),
    ).toEqual([{ device_id: 'phone', phasset_local_id: 'L1', phasset_cloud_id: 'C1' }]);

    // The survivor is not re-queued for work it inherited, and the blob that
    // reads the inherited text is re-armed.
    expect(stage(live.db, pair.survivor, 'describe')).toEqual({ version: 9 });
    expect(stage(live.db, pair.survivor, 'face-detect')).toEqual({ version: 2 });
    expect(stage(live.db, pair.survivor, 'geocode')).toEqual({ version: 3 });
    expect(stage(live.db, pair.survivor, 'search-blob')).toEqual({ version: 0 });
  });

  it("keeps the survivor's own describe output, faces and place when both rows have them", async () => {
    using live = await createLiveTestDatabase();
    const pair = seedPair(live.db);
    for (const [id, text] of [
      [pair.survivor, 'survivor caption'],
      [pair.condemned, 'condemned caption'],
    ] as const) {
      insertDetail(live.db, id, {
        description: text,
        descriptionMeta: `{"from":"${text}"}`,
        ocrText: `ocr ${text}`,
      });
      insertFaceRow(live.db, { assetId: id, faceIndex: 0, embedding: `"${text}"` });
      run(live.db, `UPDATE assets SET place = ? WHERE id = ?`, `{"from":"${text}"}`, id);
    }
    insertFaceRow(live.db, { assetId: pair.condemned, faceIndex: 1 });
    insertStageState(live.db, pair.survivor, 'describe', { version: 4 });
    insertStageState(live.db, pair.condemned, 'describe', { version: 9 });
    insertStageState(live.db, pair.survivor, 'search-blob', { version: 10 });

    await merge(pair);

    expect(detail(live.db, pair.survivor)).toMatchObject({
      description: 'survivor caption',
      description_meta: '{"from":"survivor caption"}',
      ocr_text: 'ocr survivor caption',
    });
    expect(faceCount(live.db, pair.survivor)).toBe(1);
    expect(
      live.db.query(`SELECT embedding FROM faces WHERE asset_id = ?`).get(pair.survivor),
    ).toEqual({ embedding: '"survivor caption"' });
    expect(live.db.query(`SELECT place FROM assets WHERE id = ?`).get(pair.survivor)).toEqual({
      place: '{"from":"survivor caption"}',
    });
    // Nothing was inherited, so the survivor's own stage state is left alone.
    expect(stage(live.db, pair.survivor, 'describe')).toEqual({ version: 4 });
    expect(stage(live.db, pair.survivor, 'search-blob')).toEqual({ version: 10 });
  });

  it('fills only the groups the survivor lacks, keeping a description and its provenance from one row', async () => {
    using live = await createLiveTestDatabase();
    const pair = seedPair(live.db);
    insertDetail(live.db, pair.survivor, {
      description: 'survivor caption',
      descriptionMeta: '{"s":1}',
    });
    insertDetail(live.db, pair.condemned, {
      description: 'condemned caption',
      descriptionMeta: '{"c":1}',
      ocrText: 'ocr from condemned',
      ocrMeta: '{"c":2}',
      transcript: '{"text":"spoken"}',
    });

    await merge(pair);

    expect(detail(live.db, pair.survivor)).toMatchObject({
      description: 'survivor caption',
      description_meta: '{"s":1}',
      ocr_text: 'ocr from condemned',
      ocr_meta: '{"c":2}',
      transcript: '{"text":"spoken"}',
    });
  });

  it('leaves a survivor without describe output eligible for its own describe run', async () => {
    using live = await createLiveTestDatabase();
    const pair = seedPair(live.db);
    insertStageState(live.db, pair.survivor, 'describe', { version: 0 });
    insertStageState(live.db, pair.condemned, 'describe', { version: 9 });
    insertStageState(live.db, pair.survivor, 'search-blob', { version: 10 });

    await merge(pair);

    // The condemned row never produced describe output, so there is nothing to inherit.
    expect(stage(live.db, pair.survivor, 'describe')).toEqual({ version: 0 });
    expect(stage(live.db, pair.survivor, 'search-blob')).toEqual({ version: 10 });
  });

  it('dedupes a Photos link both rows hold and keeps the others', async () => {
    using live = await createLiveTestDatabase();
    const pair = seedPair(live.db);
    insertPhassetLink(live.db, {
      assetId: pair.survivor,
      deviceId: 'phone',
      phassetLocalId: 'L1',
      firstSeen: '2026-01-01T00:00:00Z',
    });
    insertPhassetLink(live.db, {
      assetId: pair.condemned,
      deviceId: 'phone',
      phassetLocalId: 'L1',
      firstSeen: '2026-02-01T00:00:00Z',
    });
    insertPhassetLink(live.db, { assetId: pair.condemned, deviceId: 'ipad', phassetLocalId: 'L9' });

    await merge(pair);

    expect(
      live.db
        .query(
          `SELECT device_id || ':' || phasset_local_id AS link FROM asset_phasset_links WHERE asset_id = ? ORDER BY device_id`,
        )
        .all(pair.survivor),
    ).toEqual([{ link: 'ipad:L9' }, { link: 'phone:L1' }]);
    expect(
      live.db
        .query(
          `SELECT first_seen FROM asset_phasset_links WHERE asset_id = ? AND device_id = 'phone'`,
        )
        .get(pair.survivor),
    ).toEqual({ first_seen: '2026-01-01T00:00:00Z' });
  });

  it('still moves locations, claims the id and carries rating, flag, colour and EXIF', async () => {
    using live = await createLiveTestDatabase();
    const pair = seedPair(live.db);

    await mergeIntoSurvivor({
      survivorId: pair.survivor,
      condemnedId: pair.condemned,
      mapleId: SURVIVOR_ID,
      carryOver: {
        rating: 4,
        flag: 1,
        colorLabel: 'red',
        exif: { captured_at: '2024-06-01T12:34:56.000Z' } as never,
      },
    });

    expect(
      live.db
        .query(`SELECT path FROM asset_locations WHERE asset_id = ? ORDER BY path`)
        .all(pair.survivor),
    ).toEqual([{ path: 'a' }, { path: 'b' }]);
    expect(
      live.db
        .query(
          `SELECT maple_id, rating, flag, color_label, json_extract(exif, '$.captured_at') AS at FROM assets WHERE id = ?`,
        )
        .get(pair.survivor),
    ).toEqual({
      maple_id: SURVIVOR_ID,
      rating: 4,
      flag: 1,
      color_label: 'red',
      at: '2024-06-01T12:34:56.000Z',
    });
  });
});
