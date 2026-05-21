/**
 * Shared helpers for the discover-producer test suites (split per concern;
 * see #251). Not a test file — name does not match Bun's `*.test.ts` glob,
 * so it never runs as a test on its own.
 *
 * Centralises the MongoDB reach-test + connect-and-drop ritual so each
 * `discover.<concern>.test.ts` file repeats only the minimum boilerplate.
 *
 * Each consumer sets `process.env.MAPLE_MONGO_DB` BEFORE importing this
 * module so the assignment is observed by `db/client.ts` on its first
 * (dynamic) import inside the test bodies — see lines 18-19 of the
 * pre-split discover.test.ts for the rationale.
 */
import { MongoClient } from 'mongodb';

export const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

export async function tryConnect(): Promise<MongoClient | null> {
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
