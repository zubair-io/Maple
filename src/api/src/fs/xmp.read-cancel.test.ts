import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mirrorRead from './mirror-read.ts';
import { updateXmpAtomic } from './xmp.ts';

let oldRoots: string | undefined;
let root: string;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-read-cancel-')));
  process.env.MAPLE_ROOTS = root;
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await rm(root, { recursive: true, force: true });
});

test('cancelling a stalled primary sidecar read releases the write barrier', async () => {
  const rawPath = join(root, 'photo.dng');
  const sidecarPath = join(root, 'photo.xmp');
  const original = '<x:xmpmeta />';
  await writeFile(rawPath, Buffer.from([1, 2, 3]));
  await writeFile(sidecarPath, original);

  const realRead = mirrorRead.readFileWithFailover;
  const { promise: stalledRead, resolve: releaseStalledRead } = Promise.withResolvers<void>();
  const { promise: readStarted, resolve: markReadStarted } = Promise.withResolvers<void>();
  let reads = 0;
  const readSpy = spyOn(mirrorRead, 'readFileWithFailover').mockImplementation(async (file) => {
    reads++;
    if (reads === 1) {
      markReadStarted();
      await stalledRead;
    }
    return realRead(file);
  });
  const controller = new AbortController();

  try {
    const cancelled = updateXmpAtomic(rawPath, (xml) => xml, controller.signal, root);
    await readStarted;
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false });

    await expect(updateXmpAtomic(rawPath, (xml) => xml, undefined, root)).resolves.toMatchObject({
      ok: true,
    });
    expect(reads).toBe(2);
    expect(await readFile(sidecarPath, 'utf8')).toBe(original);
  } finally {
    readSpy.mockRestore();
    releaseStalledRead();
  }
});
