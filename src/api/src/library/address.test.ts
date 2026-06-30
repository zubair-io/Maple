/**
 * Tests for parseAddressPath and resolveAddress.
 *
 * resolveAddress tests that depend on a real library root use a tmp dir
 * registered via setLibraryRootsForTests in libraries.cache.ts. This
 * avoids a Mongo dependency for pure-jail tests.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { mkdtemp, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  parseAddressPath,
  parseAddressString,
  resolveAddress,
  resolveAddressString,
} from './address';

import { ObjectId } from 'mongodb';

let tmpRoot: string;
const TEST_SLUG = 'test-library';
const TEST_LIB_ID = new ObjectId();

beforeAll(async () => {
  // Create a real tmp directory as the library root.
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'maple-addr-test-'));
  // Create a nested subdir to test valid path resolution.
  await mkdir(path.join(tmpRoot, '2026', 'France', '0002'), { recursive: true });
  // Create a symlink that escapes the root.
  const outsideDir = await mkdtemp(path.join(tmpdir(), 'maple-outside-'));
  await symlink(outsideDir, path.join(tmpRoot, 'escape-link')).catch(() => {});

  // Register the test library slug in the in-memory cache.
  // This avoids a Mongo dependency for pure-jail tests.
  const { setLibraryBySlugForTests } = await import('../indexer/libraries.cache.ts');
  setLibraryBySlugForTests(TEST_SLUG, {
    libraryId: TEST_LIB_ID,
    root: tmpRoot,
    label: 'Test Library',
  });
});

describe('parseAddressString', () => {
  it('parses a slug:relPath address string', () => {
    expect(parseAddressString('photos:2026/France/IMG_0001.dng')).toEqual({
      slug: 'photos',
      relPath: '2026/France/IMG_0001.dng',
    });
  });

  it('parses a slug: address string with empty relPath (library root)', () => {
    expect(parseAddressString('photos:')).toEqual({ slug: 'photos', relPath: '' });
  });

  it('throws status 400 for malformed address with no colon', () => {
    expect(() => parseAddressString('nocolon')).toThrow();
    try {
      parseAddressString('nocolon');
    } catch (e) {
      expect((e as { status: number }).status).toBe(400);
    }
  });

  it('throws status 400 for empty slug (colon at position 0)', () => {
    expect(() => parseAddressString(':relPath')).toThrow();
    try {
      parseAddressString(':relPath');
    } catch (e) {
      expect((e as { status: number }).status).toBe(400);
    }
  });
});

describe('resolveAddressString', () => {
  it('resolves a valid slug:relPath address string', async () => {
    const r = await resolveAddressString(`${TEST_SLUG}:2026/France/0002`);
    expect(r.absPath).toBe(path.join(tmpRoot, '2026', 'France', '0002'));
    expect(r.libraryRoot).toBe(tmpRoot);
  });

  it('resolves a slug: address string with empty relPath to the library root', async () => {
    const r = await resolveAddressString(`${TEST_SLUG}:`);
    expect(r.absPath).toBe(tmpRoot);
  });

  it('rejects an unknown slug with status 404', async () => {
    await expect(resolveAddressString('no-such-slug:photo.dng')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects a malformed address (no colon) with status 400', async () => {
    await expect(resolveAddressString('nocolon')).rejects.toMatchObject({ status: 400 });
  });
});

describe('parseAddressPath', () => {
  it('splits the slug segment from the rest', () => {
    expect(parseAddressPath('library', ['2026', 'France', '0002', 'a.JPG'])).toEqual({
      slug: 'library',
      relPath: '2026/France/0002/a.JPG',
    });
    expect(parseAddressPath('library', [])).toEqual({ slug: 'library', relPath: '' });
  });

  it('handles a single segment', () => {
    expect(parseAddressPath('my-lib', ['folder'])).toEqual({
      slug: 'my-lib',
      relPath: 'folder',
    });
  });
});

describe('resolveAddress', () => {
  it('rejects traversal with ..', async () => {
    await expect(resolveAddress(TEST_SLUG, '../etc/passwd')).rejects.toMatchObject({
      status: 400,
    });
    await expect(resolveAddress(TEST_SLUG, 'a/../../b')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects absolute relPath', async () => {
    await expect(resolveAddress(TEST_SLUG, '/etc/passwd')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects backslashes', async () => {
    await expect(resolveAddress(TEST_SLUG, 'a\\b')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects dot-segment (.)', async () => {
    await expect(resolveAddress(TEST_SLUG, 'a/./b')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('404s an unknown slug', async () => {
    await expect(resolveAddress('no-such-slug', 'a.JPG')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('resolves a valid path inside the jail', async () => {
    const r = await resolveAddress(TEST_SLUG, '2026/France/0002');
    expect(r.absPath).toBe(path.join(tmpRoot, '2026', 'France', '0002'));
    expect(r.libraryId.toHexString()).toBe(TEST_LIB_ID.toHexString());
    expect(r.libraryRoot).toBe(tmpRoot);
  });

  it('resolves empty relPath to library root', async () => {
    const r = await resolveAddress(TEST_SLUG, '');
    expect(r.absPath).toBe(tmpRoot);
  });

  it('blocks symlink escape', async () => {
    // escape-link is a symlink inside the root pointing outside
    await expect(resolveAddress(TEST_SLUG, 'escape-link/secret')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('blocks symlink escape under a multi-level non-existent tail', async () => {
    // Regression: a single-level parent realpath misses an escaping symlink
    // when the non-existent tail is more than one segment deep. The walk-up
    // must reach the nearest EXISTING ancestor (escape-link) and resolve it.
    await expect(resolveAddress(TEST_SLUG, 'escape-link/nope/deeper')).rejects.toMatchObject({
      status: 400,
    });
  });
});
