// Unit tests for fs/root-connectivity.ts (#2892). Pure filesystem — no Mongo.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  resetConnectivityCacheForTests,
  rootConnected,
  rootsConnected,
} from './root-connectivity.ts';

describe('rootConnected', () => {
  let dir: string;

  beforeEach(async () => {
    resetConnectivityCacheForTests();
    dir = await mkdtemp(nodePath.join(tmpdir(), 'maple-conn-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a non-empty root with indexed files as connected', async () => {
    await writeFile(nodePath.join(dir, 'a.dng'), 'x');
    expect(await rootConnected(dir, 12)).toBe(true);
  });

  it('reports a missing path as disconnected', async () => {
    expect(await rootConnected(nodePath.join(dir, 'nope'), 12)).toBe(false);
  });

  it('reports an EMPTY root with indexed files as disconnected (unmounted-share signature)', async () => {
    // The mount point stats fine but lists empty while the library claims
    // indexed files — the classic unmounted SMB/bind-mount shape.
    expect(await rootConnected(dir, 12)).toBe(false);
  });

  it('reports a just-registered empty root (file_count 0) as connected', async () => {
    expect(await rootConnected(dir, 0)).toBe(true);
  });

  it('does NOT extend the empty-root grace to a legacy doc with no file_count', async () => {
    // `undefined` means the field predates denormalization, not "known
    // empty" — an empty root under an unknown count is the unmounted-share
    // signature and must read as disconnected.
    expect(await rootConnected(dir, undefined)).toBe(false);
    resetConnectivityCacheForTests();
    await writeFile(nodePath.join(dir, 'a.dng'), 'x');
    expect(await rootConnected(dir, undefined)).toBe(true);
  });

  it('reports a path that exists but is not a directory as disconnected', async () => {
    const filePath = nodePath.join(dir, 'not-a-dir');
    await writeFile(filePath, 'x');
    expect(await rootConnected(filePath, 0)).toBe(false);
  });

  it('caches results until reset', async () => {
    expect(await rootConnected(dir, 12)).toBe(false);
    // Root becomes non-empty, but the cached "disconnected" still serves…
    await writeFile(nodePath.join(dir, 'a.dng'), 'x');
    expect(await rootConnected(dir, 12)).toBe(false);
    // …until the cache is dropped.
    resetConnectivityCacheForTests();
    expect(await rootConnected(dir, 12)).toBe(true);
  });

  it('rootsConnected maps each path independently', async () => {
    const missing = nodePath.join(dir, 'gone');
    const map = await rootsConnected([
      { path: dir, fileCount: 0 },
      { path: missing, fileCount: 3 },
    ]);
    expect(map.get(dir)).toBe(true);
    expect(map.get(missing)).toBe(false);
  });
});
