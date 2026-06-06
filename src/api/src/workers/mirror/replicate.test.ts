/**
 * replicate.ts unit tests — pure fs, no Mongo. Covers the staleness predicate
 * and the atomic, mtime-preserving copy used by the mirror copy worker.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { needsReplication, statOrNull, copyFileToMirror } from './replicate.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-mirror-rep-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const fakeStat = (size: number, mtimeMs: number): Stats => ({ size, mtimeMs }) as Stats;

describe('needsReplication', () => {
  test('replicates when the mirror is absent', () => {
    expect(needsReplication(fakeStat(10, 1000), null)).toBe(true);
  });
  test('replicates on a size mismatch', () => {
    expect(needsReplication(fakeStat(10, 1000), fakeStat(9, 1000))).toBe(true);
  });
  test('replicates when the primary is newer (beyond 1s granularity)', () => {
    expect(needsReplication(fakeStat(10, 5000), fakeStat(10, 1000))).toBe(true);
  });
  test('skips when same size and mirror is current', () => {
    expect(needsReplication(fakeStat(10, 1000), fakeStat(10, 1000))).toBe(false);
    // mirror newer, or within 1s tolerance, is still up to date
    expect(needsReplication(fakeStat(10, 1500), fakeStat(10, 1000))).toBe(false);
    expect(needsReplication(fakeStat(10, 1000), fakeStat(10, 9000))).toBe(false);
  });
});

describe('statOrNull', () => {
  test('returns null for a missing path, Stats for an existing one', async () => {
    expect(await statOrNull(path.join(dir, 'nope'))).toBeNull();
    const p = path.join(dir, 'f');
    await fs.writeFile(p, 'x');
    expect((await statOrNull(p))?.size).toBe(1);
  });
});

describe('copyFileToMirror', () => {
  test('copies bytes, creates parent dirs, leaves no temp behind', async () => {
    const src = path.join(dir, 'src.dng');
    await fs.writeFile(src, 'raw-bytes');
    const dst = path.join(dir, 'mirror', 'a', 'b', 'src.dng');
    await copyFileToMirror(src, dst);

    expect(await fs.readFile(dst, 'utf8')).toBe('raw-bytes');
    const leftovers = (await fs.readdir(path.dirname(dst))).filter((n) =>
      n.includes('.mirror.tmp.'),
    );
    expect(leftovers).toHaveLength(0);
  });

  test('preserves the source mtime on the mirror copy', async () => {
    const src = path.join(dir, 'src.dng');
    await fs.writeFile(src, 'bytes');
    const epoch = new Date('2021-06-07T08:09:10Z');
    await fs.utimes(src, epoch, epoch);

    const dst = path.join(dir, 'm', 'src.dng');
    await copyFileToMirror(src, dst);

    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dst)]);
    expect(Math.abs(d.mtimeMs - s.mtimeMs)).toBeLessThan(1000);
  });

  test('overwrites a stale mirror file atomically', async () => {
    const src = path.join(dir, 'src.dng');
    const dst = path.join(dir, 'src.dng.mirror');
    await fs.writeFile(dst, 'OLD');
    await fs.writeFile(src, 'NEW-CONTENT');
    await copyFileToMirror(src, dst);
    expect(await fs.readFile(dst, 'utf8')).toBe('NEW-CONTENT');
  });
});
