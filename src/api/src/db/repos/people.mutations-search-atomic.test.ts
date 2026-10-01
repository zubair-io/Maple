import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { ObjectId } from '../object-id.ts';
import { createTestDatabase } from '../sqlite/test-sqlite.test-helpers.ts';
import type { SqliteDb } from './db-handle.ts';
import { assignFaceToPerson, hideFace, renamePerson } from './people.repo.ts';
import { mergePeopleInto } from './people.merge.ts';
import { excludePerson, hidePerson, unexcludePerson, unhidePerson } from './people.visibility.ts';
import { MEILI_STAGE } from './assets.stage-rearm.ts';
import { insertStageState } from './assets.test-helpers.ts';
import { stageRow } from './stage-runtime.test-helpers.ts';
import {
  insertFace,
  insertLibrary,
  insertLiveAsset,
  insertPerson,
  testDb,
} from './people.test-helpers.ts';

interface Fixture {
  subject: ObjectId;
  other: ObjectId;
  asset: ObjectId;
  db: SqliteDb;
}

const mutations: Array<{
  name: string;
  run: (fixture: Fixture) => Promise<unknown>;
  initialHidden?: boolean;
  initialExcluded?: boolean;
  merges?: boolean;
}> = [
  { name: 'rename', run: (f) => renamePerson(f.subject, 'Renamed', f.db) },
  { name: 'collision merge', run: (f) => renamePerson(f.subject, 'Beta', f.db), merges: true },
  { name: 'explicit merge', run: (f) => mergePeopleInto(f.subject, [f.other], f.db), merges: true },
  { name: 'hide person', run: (f) => hidePerson(f.subject, f.db) },
  { name: 'unhide person', run: (f) => unhidePerson(f.subject, f.db), initialHidden: true },
  { name: 'exclude person', run: (f) => excludePerson(f.subject, f.db) },
  { name: 'unexclude person', run: (f) => unexcludePerson(f.subject, f.db), initialExcluded: true },
  { name: 'assign face', run: (f) => assignFaceToPerson(f.asset, 0, f.other, f.db) },
  { name: 'hide face', run: (f) => hideFace(f.asset, 0, f.db) },
];

function state(db: Database) {
  return {
    people: db.query('SELECT * FROM people ORDER BY id').all(),
    faces: db.query('SELECT * FROM faces ORDER BY asset_id, face_index').all(),
    stages: db.query('SELECT * FROM stage_state ORDER BY asset_id, stage').all(),
  };
}

function failSearchWrites(db: Database): void {
  for (const operation of ['INSERT', 'UPDATE']) {
    db.exec(`CREATE TRIGGER reject_search_${operation} BEFORE ${operation} ON stage_state
      WHEN NEW.stage = 'meili' BEGIN SELECT RAISE(ABORT, 'search work unavailable'); END`);
  }
}

describe.each(mutations)('$name commits with its local search work', (mutation) => {
  test.each([false, true])('rollback and retry with missing stage=%s', async (missingStage) => {
    using handle = await createTestDatabase('file');
    const db = handle.db;
    const library = insertLibrary(db);
    const subject = insertPerson(db, {
      id: '1'.repeat(24),
      name: 'Alpha',
      hidden: mutation.initialHidden,
      excluded: mutation.initialExcluded,
    });
    const other = insertPerson(db, { id: '2'.repeat(24), name: 'Beta' });
    const stranger = insertPerson(db, { name: 'Unrelated' });
    const asset = insertLiveAsset(db, library);
    const otherAsset = insertLiveAsset(db, library);
    const unrelated = insertLiveAsset(db, library);
    for (const [assetId, personId] of [
      [asset, subject],
      [otherAsset, other],
      [unrelated, stranger],
    ]) {
      insertFace(db, { assetId: assetId!, personId });
      if (assetId !== asset || !missingStage) {
        insertStageState(db, assetId!, MEILI_STAGE, {
          version: 6,
          attempts: 3,
          dead: true,
          lastError: 'old failure',
          processedAt: '2025-01-01T00:00:00Z',
        });
      }
    }
    const fixture = {
      subject: new ObjectId(subject),
      other: new ObjectId(other),
      asset: new ObjectId(asset),
      db: testDb(db),
    };
    const before = state(db);
    failSearchWrites(db);
    await expect(mutation.run(fixture)).rejects.toThrow('search work unavailable');
    // This includes names, tombstones, flags, centroids and face assignments.
    expect(state(db)).toEqual(before);

    db.exec('DROP TRIGGER reject_search_INSERT; DROP TRIGGER reject_search_UPDATE');
    await mutation.run(fixture);
    expect(state(db).people).not.toEqual(before.people);
    for (const assetId of mutation.merges ? [asset, otherAsset] : [asset]) {
      expect(stageRow(db, assetId, MEILI_STAGE)).toMatchObject({
        version: 0,
        attempts: 0,
        dead: 0,
        last_error: null,
        processed_at: null,
      });
    }
    expect(stageRow(db, unrelated, MEILI_STAGE)?.version).toBe(6);
    if (!mutation.merges) expect(stageRow(db, otherAsset, MEILI_STAGE)?.version).toBe(6);
  });
});
