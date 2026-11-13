/**
 * publishFile against real temp dirs: the marker is written before the publish,
 * a file an earlier attempt landed under the marked name is recognised instead
 * of copied again, and nothing in the library is overwritten.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { holdsSource, publishFile } from './publish.ts';

const BYTES = 'the original bytes';

let dir: string;
let src: string;
let lib: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-publish-'));
  src = path.join(dir, 'IMG.dng');
  lib = path.join(dir, 'lib');
  await fs.writeFile(src, BYTES);
  await fs.mkdir(path.join(lib, '2024'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const inLibrary = (destRel: string) => path.join(lib, destRel);
const libraryNames = async () => (await fs.readdir(path.join(lib, '2024'))).sort();

test('the resolved name is handed to beforePublish while the destination is still empty', async () => {
  await fs.writeFile(inLibrary('2024/IMG.dng'), 'a different photo');
  const seen: { destRel: string; names: string[] }[] = [];

  const outcome = await publishFile(lib, src, '2024/IMG.dng', {
    beforePublish: async (destRel) => {
      seen.push({ destRel, names: await libraryNames() });
    },
  });

  expect(outcome).toEqual({ state: 'copied', error: null, destRel: '2024/IMG-1.dng' });
  expect(seen).toEqual([{ destRel: '2024/IMG-1.dng', names: ['IMG.dng'] }]);
  expect(await fs.readFile(inLibrary('2024/IMG.dng'), 'utf8')).toBe('a different photo');
  expect(await fs.readFile(inLibrary('2024/IMG-1.dng'), 'utf8')).toBe(BYTES);
});

test('a file already present with the same bytes is skipped without a marker', async () => {
  await fs.writeFile(inLibrary('2024/IMG.dng'), BYTES);
  const markedNames: string[] = [];

  const outcome = await publishFile(lib, src, '2024/IMG.dng', {
    beforePublish: async (destRel) => {
      markedNames.push(destRel);
    },
  });

  expect(outcome).toEqual({
    state: 'skipped_duplicate',
    error: null,
    destRel: '2024/IMG.dng',
    alreadyPresent: true,
  });
  expect(markedNames).toEqual([]);
});

test('a file an earlier attempt landed under the name it marked is not copied again', async () => {
  await fs.writeFile(inLibrary('2024/IMG.dng'), 'a different photo');
  await fs.writeFile(inLibrary('2024/IMG-1.dng'), BYTES);

  const outcome = await publishFile(lib, src, '2024/IMG.dng', { earlierDest: '2024/IMG-1.dng' });

  expect(outcome).toEqual({
    state: 'copied',
    error: null,
    destRel: '2024/IMG-1.dng',
    landedEarlier: true,
  });
  expect(await libraryNames()).toEqual(['IMG-1.dng', 'IMG.dng']);
});

test('an earlier attempt that lands its renamed copy while this one is copying wins, with no second copy', async () => {
  await fs.writeFile(inLibrary('2024/IMG.dng'), 'a different photo');

  const outcome = await publishFile(lib, src, '2024/IMG.dng', {
    earlierDest: '2024/IMG-1.dng',
    beforePublish: async (destRel) => {
      await fs.writeFile(inLibrary(destRel), BYTES);
    },
  });

  expect(outcome).toEqual({
    state: 'copied',
    error: null,
    destRel: '2024/IMG-1.dng',
    landedEarlier: true,
  });
  expect(await libraryNames()).toEqual(['IMG-1.dng', 'IMG.dng']);
});

test('a marked name that never received the file is no reason to skip the copy', async () => {
  const outcome = await publishFile(lib, src, '2024/IMG.dng', { earlierDest: '2024/IMG.dng' });

  expect(outcome).toEqual({ state: 'copied', error: null, destRel: '2024/IMG.dng' });
  expect(await fs.readFile(inLibrary('2024/IMG.dng'), 'utf8')).toBe(BYTES);
});

test('with keepExisting a different file at the destination is left alone and nothing is copied', async () => {
  await fs.writeFile(inLibrary('2024/IMG.dng'), 'edits made in the library');

  const outcome = await publishFile(lib, src, '2024/IMG.dng', { keepExisting: true });

  expect(outcome).toEqual({ state: 'skipped_duplicate', error: null, destRel: '2024/IMG.dng' });
  expect(await libraryNames()).toEqual(['IMG.dng']);
  expect(await fs.readFile(inLibrary('2024/IMG.dng'), 'utf8')).toBe('edits made in the library');
});

test('a marker that cannot be written stops the publish and is thrown, not recorded as a file failure', async () => {
  const refused = new Error('This attempt no longer holds the import');

  await expect(
    publishFile(lib, src, '2024/IMG.dng', {
      beforePublish: async () => {
        throw refused;
      },
    }),
  ).rejects.toBe(refused);
  expect(await libraryNames()).toEqual([]);
});

test('a source that cannot be read fails the file and publishes nothing', async () => {
  const missing = path.join(dir, 'gone.dng');

  const outcome = await publishFile(lib, missing, '2024/gone.dng');

  expect(outcome.state).toBe('failed');
  expect(outcome.error).toContain('ENOENT');
  expect(await libraryNames()).toEqual([]);
});

test("a file already at the marked name is the earlier attempt's copy, not a duplicate", async () => {
  await fs.writeFile(inLibrary('2024/IMG.dng'), BYTES);

  const outcome = await publishFile(lib, src, '2024/IMG.dng', { earlierDest: '2024/IMG.dng' });

  expect(outcome).toEqual({
    state: 'copied',
    error: null,
    destRel: '2024/IMG.dng',
    landedEarlier: true,
  });
});

test('a marked name that cannot be read fails the file; it is not copied under a sibling name', async () => {
  await fs.writeFile(inLibrary('2024/IMG.dng'), 'a different photo');
  await fs.writeFile(inLibrary('2024/IMG-1.dng'), BYTES);
  await fs.chmod(inLibrary('2024/IMG-1.dng'), 0o000);

  const outcome = await publishFile(lib, src, '2024/IMG.dng', { earlierDest: '2024/IMG-1.dng' });
  await fs.chmod(inLibrary('2024/IMG-1.dng'), 0o644);

  expect(outcome.state).toBe('failed');
  expect(await libraryNames()).toEqual(['IMG-1.dng', 'IMG.dng']);
});

test('holdsSource is true only for the exact bytes, false for a free name, and throws for a file it cannot read', async () => {
  await fs.writeFile(inLibrary('2024/same.dng'), BYTES);
  await fs.writeFile(inLibrary('2024/other.dng'), 'a different photo');
  await fs.writeFile(inLibrary('2024/locked.dng'), BYTES);
  await fs.chmod(inLibrary('2024/locked.dng'), 0o000);

  expect(await holdsSource(lib, '2024/same.dng', src)).toBe(true);
  expect(await holdsSource(lib, '2024/other.dng', src)).toBe(false);
  expect(await holdsSource(lib, '2024/absent.dng', src)).toBe(false);
  await expect(holdsSource(lib, '2024/locked.dng', src)).rejects.toThrow();
  await fs.chmod(inLibrary('2024/locked.dng'), 0o644);
});
