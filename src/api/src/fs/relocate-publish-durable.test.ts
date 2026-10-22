/**
 * The exclusive copy that `publishExclusive` falls back to where hard links
 * aren't supported (SMB, exFAT) flushes the published file before it reports
 * success (#5152): a staged temp's fsync doesn't cover a separate copy.
 * Real files in a temp directory.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as mirroredFs from './mirrored.ts';
import { mkdtemp, readFile, rm, writeFile } from './mirrored.ts';
import { publishExclusive } from './relocate-publish.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'relocate-publish-durable-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a copy published where links are refused is flushed before it counts', async () => {
  const staged = path.join(dir, 'staged.tmp');
  const destination = path.join(dir, 'photo.xmp');
  await writeFile(staged, 'edit');
  const link = spyOn(mirroredFs, 'link').mockRejectedValue(
    Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
  );
  const flushed: string[] = [];
  const realOpen = mirroredFs.open;
  const open = spyOn(mirroredFs, 'open').mockImplementation((async (
    ...args: Parameters<typeof realOpen>
  ) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === destination) {
      const sync = handle.datasync.bind(handle);
      handle.datasync = async () => {
        flushed.push(destination);
        return sync();
      };
    }
    return handle;
  }) as typeof realOpen);
  try {
    await publishExclusive(staged, destination);
  } finally {
    link.mockRestore();
    open.mockRestore();
  }
  expect(flushed).toEqual([destination]);
  expect(await readFile(destination, 'utf8')).toBe('edit');
});
