import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from './mirrored.ts';
import {
  adoptLegacyDerivative,
  legacyDerivativePath,
  moveNoClobber,
  parseVersionedDerivativeName,
  readDerivative,
} from './legacy-derivative.ts';
import { sha256Prefix16 } from './xmp.ts';
import { isDerivativeCacheFresh } from '../indexer/derivative-cache.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'maple-legacy-derivative-'));
  await mkdir(join(root, '.maple', 'thumbs'), { recursive: true });
  await mkdir(join(root, '.maple', 'previews'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('legacyDerivativePath', () => {
  it('maps a thumb to its frozen hashed v25 name', () => {
    expect(legacyDerivativePath('/lib/.maple/thumbs/IMG_1234.CR2.avif')).toBe(
      `/lib/.maple/thumbs/${sha256Prefix16('IMG_1234.CR2')}.v25.avif`,
    );
  });

  it('maps a preview to its frozen v25 name', () => {
    expect(legacyDerivativePath('/lib/.maple/previews/IMG_1234.CR2.avif')).toBe(
      '/lib/.maple/previews/IMG_1234.CR2.v25.avif',
    );
  });

  it('has no legacy name for a non-AVIF artefact', () => {
    expect(legacyDerivativePath('/lib/.maple/previews/IMG_1234.CR2.histogram.json')).toBeNull();
  });
});

describe('parseVersionedDerivativeName', () => {
  it('strips the version segment from every versioned kind', () => {
    expect(parseVersionedDerivativeName('a.dng.v25.avif')).toEqual({
      unversioned: 'a.dng.avif',
      version: 25,
    });
    expect(parseVersionedDerivativeName('a.dng.v7.avif.source.json')?.unversioned).toBe(
      'a.dng.avif.source.json',
    );
    expect(parseVersionedDerivativeName('a.dng.v25.preview.json')?.unversioned).toBe(
      'a.dng.preview.json',
    );
  });

  it('does not mistake a version-like token inside a filename', () => {
    expect(parseVersionedDerivativeName('IMG.v2.final.ARW.avif')).toBeNull();
    expect(parseVersionedDerivativeName('clip.v3.jpg.avif')).toBeNull();
  });
});

describe('adoptLegacyDerivative', () => {
  it('renames the legacy thumb into place on a miss', async () => {
    const target = join(root, '.maple', 'thumbs', 'photo.dng.avif');
    await writeFile(legacyDerivativePath(target)!, 'legacy');

    expect(await adoptLegacyDerivative(target)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('legacy');
    expect(await readdir(join(root, '.maple', 'thumbs'))).toEqual(['photo.dng.avif']);
  });

  it('never overwrites an existing unversioned file, and leaves the legacy file for cache-gc', async () => {
    const target = join(root, '.maple', 'previews', 'photo.dng.avif');
    await writeFile(target, 'current');
    await writeFile(legacyDerivativePath(target)!, 'legacy');

    expect(await adoptLegacyDerivative(target)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('current');
    expect(await readFile(legacyDerivativePath(target)!, 'utf8')).toBe('legacy');
  });

  it('is a plain miss when there is no legacy file', async () => {
    expect(await adoptLegacyDerivative(join(root, '.maple', 'previews', 'none.dng.avif'))).toBe(
      false,
    );
  });
});

describe('moveNoClobber', () => {
  it('moves when the destination is free', async () => {
    const from = join(root, '.maple', 'previews', 'a.v25.avif');
    const to = join(root, '.maple', 'previews', 'a.avif');
    await writeFile(from, 'legacy');

    expect(await moveNoClobber(from, to)).toBe('moved');
    expect(await readdir(join(root, '.maple', 'previews'))).toEqual(['a.avif']);
  });

  it('reports an existing destination and leaves both files untouched', async () => {
    const from = join(root, '.maple', 'previews', 'a.v25.avif');
    const to = join(root, '.maple', 'previews', 'a.avif');
    await writeFile(from, 'legacy');
    await writeFile(to, 'fresh');

    expect(await moveNoClobber(from, to)).toBe('exists');
    expect(await readFile(to, 'utf8')).toBe('fresh');
    expect(await readFile(from, 'utf8')).toBe('legacy');
  });
});

describe('legacy adoption on the read path', () => {
  it('readDerivative serves a not-yet-renamed legacy preview', async () => {
    const target = join(root, '.maple', 'previews', 'photo.dng.avif');
    await writeFile(legacyDerivativePath(target)!, 'legacy');

    expect((await readDerivative(target)).toString()).toBe('legacy');
    expect(await readdir(join(root, '.maple', 'previews'))).toEqual(['photo.dng.avif']);
  });

  it('isDerivativeCacheFresh adopts a fresh legacy thumb instead of reporting a miss', async () => {
    const source = join(root, 'photo.dng');
    await writeFile(source, 'original');
    const past = new Date(Date.now() - 60_000);
    await utimes(source, past, past);
    const target = join(root, '.maple', 'thumbs', 'photo.dng.avif');
    await writeFile(legacyDerivativePath(target)!, 'legacy');

    expect(await isDerivativeCacheFresh(target, source)).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('legacy');
  });
});
