/**
 * A discovery visit settles the private names a crashed relocation left in the
 * folder (#5136, #5786): a verifying copy is removed, a displaced file with no
 * other copy is published under a visible name the next visit indexes, and a
 * photo, a sidecar and an unmarked leftover from an earlier build are never
 * touched. Real files in a temp library.
 */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { basename, join } from 'node:path';
import * as fs from '../../fs/mirrored.ts';
import {
  DISPLACED_MARKER,
  privateSiblingOf,
  VERIFYING_COPY_MARKER,
} from '../../fs/private-sibling.ts';
import { createDiscoverLibrary, type DiscoverLibrary } from './discover.test-helpers.ts';
import * as frontier from './frontier.repo.ts';
import { visitDirectory } from './sweeper.ts';
import type { WatchEvent } from './types.ts';

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const dead = (name: string) => name.replace(String(process.pid), '99999999');

afterEach(() => setSystemTime());

async function visit(library: DiscoverLibrary, generation: number): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  await frontier.seedRoot(library.folderId, library.root, generation);
  const dir = await frontier.claimNextDir(library.folderId, generation, 60_000);
  setSystemTime(new Date(Date.now() + TWO_DAYS_MS));
  try {
    await visitDirectory(dir!, library.root, {
      handleEvent: async (event) => {
        events.push(event);
      },
      folderId: library.folderId,
    });
  } finally {
    setSystemTime();
  }
  return events;
}

const created = (events: readonly WatchEvent[]) =>
  events.map((event) => event.absPath.split('/').pop()).sort();

describe('visitDirectory and a crashed relocation', () => {
  it('removes an abandoned verifying copy and publishes a displaced photo under a visible name', async () => {
    using library = await createDiscoverLibrary('maple-sweep-');
    const { root } = library;
    await fs.writeFile(join(root, 'IMG_1.dng'), 'pixels');
    await fs.writeFile(join(root, 'IMG_1.xmp'), '<x/>');
    await fs.writeFile(
      dead(privateSiblingOf(join(root, 'IMG_2.dng'), VERIFYING_COPY_MARKER)),
      'partial copy',
    );
    await fs.writeFile(
      dead(privateSiblingOf(join(root, 'IMG_3.dng'), DISPLACED_MARKER)),
      'only copy',
    );
    const legacyPath = dead(privateSiblingOf(join(root, 'IMG_4.dng')));
    await fs.writeFile(legacyPath, 'unknown');
    const legacy = basename(legacyPath);

    expect(created(await visit(library, 1))).toEqual(['IMG_1.dng']);
    expect((await fs.readdir(root)).sort()).toEqual(
      ['IMG_1.dng', 'IMG_1.xmp', 'IMG_3 (replaced).dng', legacy].sort(),
    );
    expect(await fs.readFile(join(root, 'IMG_3 (replaced).dng'), 'utf8')).toBe('only copy');

    expect(created(await visit(library, 2))).toEqual(['IMG_1.dng', 'IMG_3 (replaced).dng']);
  });
});
