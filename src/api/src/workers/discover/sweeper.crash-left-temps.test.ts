/**
 * A discovery visit removes the private temps a crashed relocation left in the
 * folder (#5136), and only those: a photo, a sidecar and a displaced file with
 * no second name are never touched. Real files in a temp library.
 */
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import * as fs from '../../fs/mirrored.ts';
import { privateSiblingOf, VERIFYING_COPY_MARKER } from '../../fs/private-sibling.ts';
import { createDiscoverLibrary } from './discover.test-helpers.ts';
import * as frontier from './frontier.repo.ts';
import { visitDirectory } from './sweeper.ts';
import type { WatchEvent } from './types.ts';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

async function leftBehind(path: string, content: string): Promise<string> {
  await fs.writeFile(path, content);
  const when = new Date(Date.now() - TWO_DAYS_MS);
  await fs.utimes(path, when, when);
  return path;
}

describe('visitDirectory and a crashed relocation', () => {
  it('removes an abandoned verifying copy and keeps everything else in the folder', async () => {
    using library = await createDiscoverLibrary('maple-sweep-');
    const { root } = library;
    await fs.writeFile(join(root, 'IMG_1.dng'), 'pixels');
    await fs.writeFile(join(root, 'IMG_1.xmp'), '<x/>');
    const dead = (name: string) => name.replace(String(process.pid), '99999999');
    await leftBehind(
      dead(privateSiblingOf(join(root, 'IMG_2.dng'), VERIFYING_COPY_MARKER)),
      'partial copy',
    );
    const displaced = await leftBehind(
      dead(privateSiblingOf(join(root, 'IMG_3.dng'))),
      'only copy',
    );

    const events: WatchEvent[] = [];
    await frontier.seedRoot(library.folderId, root, 1);
    const dir = await frontier.claimNextDir(library.folderId, 1, 60_000);
    await visitDirectory(dir!, root, {
      handleEvent: async (event) => {
        events.push(event);
      },
      folderId: library.folderId,
    });

    expect((await fs.readdir(root)).sort()).toEqual(
      ['IMG_1.dng', 'IMG_1.xmp', displaced.split('/').pop()!].sort(),
    );
    expect(events.map((event) => event.absPath.split('/').pop())).toEqual(['IMG_1.dng']);
  });
});
