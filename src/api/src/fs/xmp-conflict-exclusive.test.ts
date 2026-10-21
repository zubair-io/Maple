/**
 * A device's conflict copy is published exclusively (#5071): the movers publish
 * theirs under other barriers, so one can take the name a device's stale save
 * just picked, and the device copy must take the next free name instead.
 * Real files in a temp library.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mirroredFs from './mirrored.ts';
import { mkdtemp, readFile, realpath, rm, writeFile } from './mirrored.ts';
import * as xmpConflict from './xmp-conflict.ts';
import { writeXmpWithPrecondition } from './xmp.ts';

let oldRoots: string | undefined;
let root: string;

beforeEach(async () => {
  oldRoots = process.env.MAPLE_ROOTS;
  root = await realpath(await mkdtemp(join(tmpdir(), 'maple-xmp-conflict-exclusive-')));
  process.env.MAPLE_ROOTS = root;
});

afterEach(async () => {
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await rm(root, { recursive: true, force: true });
});

const DEVICE_EDIT = '<x:xmpmeta>device</x:xmpmeta>';

test.each([false, true])(
  "a device's conflict copy never replaces one a mover published at its name (links refused: %p)",
  async (linksRefused) => {
    const rawPath = join(root, 'IMG.HEIC');
    await writeFile(rawPath, Buffer.from([0x49, 0x49, 0x2a, 0x00]));
    await writeFile(join(root, 'IMG.xmp'), '<x:xmpmeta/>');
    const link = linksRefused
      ? spyOn(mirroredFs, 'link').mockRejectedValue(
          Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
        )
      : null;
    const realPick = xmpConflict.pickFreeConflictPath;
    const pick = spyOn(xmpConflict, 'pickFreeConflictPath').mockImplementationOnce(
      async (photo, device, signal) => {
        const picked = await realPick(photo, device, signal);
        await writeFile(picked, "the mover's edit");
        return picked;
      },
    );
    try {
      const outcome = await writeXmpWithPrecondition(rawPath, DEVICE_EDIT, 1, 'move');

      expect(outcome.kind).toBe('conflict');
      const conflictPath = outcome.kind === 'conflict' ? outcome.conflictPath : '';
      expect(conflictPath).toBe(join(root, 'IMG (conflict from move) (2).xmp'));
      expect(await readFile(conflictPath, 'utf8')).toBe(DEVICE_EDIT);
      if (link) expect(link).toHaveBeenCalled();
    } finally {
      pick.mockRestore();
      link?.mockRestore();
    }
    expect(await readFile(join(root, 'IMG (conflict from move).xmp'), 'utf8')).toBe(
      "the mover's edit",
    );
  },
);
