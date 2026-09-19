/**
 * The boot migration says which end failed (#3792).
 *
 * `openImportSession` opens the destination file before it connects to the
 * source, so for a while every failure from it was reported as "MongoDB is not
 * reachable". That cost a production cutover: the server restart-looped
 * blaming a healthy database, and the path it had actually tried appeared only
 * in the nested cause.
 *
 * These assert on the sentence an operator reads rather than on the error
 * type, because the type was already right and the sentence was what was wrong.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateAtBoot } from './boot-migration.ts';

/**
 * A port nothing listens on. The timeout is in the string on purpose: the
 * driver's default server selection window is 30s, which is longer than any
 * test should wait to learn something it already knows.
 */
const DEAD_MONGO = 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500';

/**
 * Captured in `beforeAll`, not at module scope: Bun evaluates every module body
 * during the import phase, before any test runs, so a module-scope read can
 * capture a value another suite has already replaced and then restore the wrong
 * one on the way out.
 */
const saved: { path?: string; uri?: string } = {};

beforeAll(() => {
  saved.path = process.env.MAPLE_SQLITE_PATH;
  saved.uri = process.env.MAPLE_MONGO_URI;
});

afterEach(() => {
  if (saved.path === undefined) delete process.env.MAPLE_SQLITE_PATH;
  else process.env.MAPLE_SQLITE_PATH = saved.path;
  if (saved.uri === undefined) delete process.env.MAPLE_MONGO_URI;
  else process.env.MAPLE_MONGO_URI = saved.uri;
});

/** The message an operator would read, for one destination and source pair. */
async function messageFrom(sqlitePath: string): Promise<string> {
  process.env.MAPLE_SQLITE_PATH = sqlitePath;
  process.env.MAPLE_MONGO_URI = DEAD_MONGO;
  try {
    await migrateAtBoot();
    throw new Error('expected the migration to refuse');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('a destination that cannot be opened', () => {
  it('names the path and does not blame the source', async () => {
    const missing = join(
      tmpdir(),
      `maple-3792-${process.pid}`,
      'no',
      'such',
      'dir',
      'maple.sqlite',
    );
    const message = await messageFrom(missing);
    expect(message).toContain(missing);
    expect(message).toContain('MAPLE_SQLITE_PATH');
    expect(message).not.toContain('is not reachable');
  }, 30_000);
});

describe('a source that cannot be reached', () => {
  it('still reports the source, once the destination is fine', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-3792-ok-'));
    try {
      const message = await messageFrom(join(dir, 'maple.sqlite'));
      expect(message).toContain('is not reachable');
      expect(message).toContain(DEAD_MONGO);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
