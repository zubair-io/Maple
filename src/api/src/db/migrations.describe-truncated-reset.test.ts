/**
 * Reset migration for describe rows dead-lettered on a truncated Ollama
 * generation (#3561).
 *
 * These rows recorded `vision-parse[not-json]: ... Unterminated string`,
 * which named the parser rather than the provider fault that produced the
 * fragment. The provider now rejects an unfinished generation itself, so
 * the dead rows are stale and should re-run.
 *
 * Skip-passes when Mongo is unreachable, same as the sibling db suites.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db, MongoClient } from 'mongodb';
import { tryConnectTestMongo } from './test-db.test-helpers.ts';

const TEST_DB = `maple_test_describe_trunc_${process.pid}`;

let mongo: MongoClient | null = null;
let db: Db | null = null;
let originalMongoDb: string | undefined;

/** The exact string prod recorded, truncated preview and all. */
const TRUNCATED_ERROR =
  'vision-parse[not-json]: JSON Parse error: Unterminated string | raw: ' +
  '{"is_screenshot": false, "people_count": 0, "caption": "A wide nighttime view of a parking lot…[truncated]';

const DEAD_STAGE = (lastError: string) => ({
  stages: { describe: { version: 0, attempts: 1, dead: true, last_error: lastError } },
});

beforeAll(async () => {
  originalMongoDb = process.env.MAPLE_MONGO_DB;
  process.env.MAPLE_MONGO_DB = TEST_DB;
  mongo = await tryConnectTestMongo();
  if (!mongo) {
    console.log('[migrations.describe-truncated-reset.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo.db(TEST_DB);
  await db.dropDatabase();
});

afterAll(async () => {
  try {
    const { closeDb } = await import('./client.ts');
    await closeDb();
    if (mongo) {
      await mongo.db(TEST_DB).dropDatabase();
      await mongo.close();
    }
  } finally {
    if (originalMongoDb === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = originalMongoDb;
  }
});

describe('reset-describe-dead-truncated-2026-09-11', () => {
  it('re-arms truncated-generation dead rows and leaves other failures parked', async () => {
    if (!db) return;

    // The broad 2026-05-22 reset already ran on every live deploy. Without
    // its sentinel it would fire here and re-arm the row on its own, and
    // this test would pass whether or not the new migration exists.
    const { recordMigration } = await import('./migrations.ts');
    for (const id of [
      'reset-describe-dead-vision-parse-2026-05-20',
      'reset-describe-dead-vision-parse-2026-05-21',
      'reset-describe-dead-vision-parse-2026-05-22',
    ] as const) {
      await recordMigration(db, id, 0);
    }

    await db.collection('assets').insertMany([
      { _id: 'truncated' as never, ...DEAD_STAGE(TRUNCATED_ERROR) },
      // A genuinely stuck asset: its upstream never produced a preview.
      // Re-arming describe cannot help, so it must stay parked.
      { _id: 'awaiting' as never, ...DEAD_STAGE('awaiting preview: preview-missing') },
    ]);

    const { closeDb, ensureIndexes } = await import('./client.ts');
    await closeDb();
    await ensureIndexes();

    const truncated = await db.collection('assets').findOne({ _id: 'truncated' as never });
    expect(truncated?.stages?.describe?.dead).toBe(false);
    expect(truncated?.stages?.describe?.attempts).toBe(0);
    expect(truncated?.stages?.describe?.last_error).toBeNull();

    const awaiting = await db.collection('assets').findOne({ _id: 'awaiting' as never });
    expect(awaiting?.stages?.describe?.dead).toBe(true);
    expect(awaiting?.stages?.describe?.last_error).toBe('awaiting preview: preview-missing');
  });

  it('is one-shot — a re-run does not re-arm a row that failed again since', async () => {
    if (!db) return;

    await db
      .collection('assets')
      .updateOne(
        { _id: 'truncated' as never },
        { $set: { 'stages.describe.dead': true, 'stages.describe.last_error': TRUNCATED_ERROR } },
      );

    const { ensureIndexes } = await import('./client.ts');
    await ensureIndexes();

    const again = await db.collection('assets').findOne({ _id: 'truncated' as never });
    expect(again?.stages?.describe?.dead).toBe(true);
  });
});
