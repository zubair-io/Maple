import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { surfaceDisplaced } from './displaced-keepers.ts';
import * as fs from './mirrored.ts';
import { DISPLACED_MARKER, privateSiblingOf } from './private-sibling.ts';
import { listPairedSidecars } from './xmp-conflict.ts';

const MAPLE_EDIT = '<x:xmpmeta xmlns:maple="http://ns.justmaple.app/1.0/">old edits</x:xmpmeta>';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'displaced-keepers-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Leaves `bytes` at the private name a crashed move gave `original`, then surfaces it. */
async function surface(original: string, bytes: string): Promise<string[]> {
  const kept = privateSiblingOf(path.join(dir, original), DISPLACED_MARKER);
  await fs.writeFile(kept, bytes);
  expect(await surfaceDisplaced(kept, original)).toBe(true);
  return (await fs.readdir(dir)).sort();
}

describe('a displaced pre-#5021 backup sidecar', () => {
  test('a Maple edit named after the photo file comes back paired with that photo', async () => {
    await fs.writeFile(path.join(dir, 'IMG.CR3'), 'photo');

    expect(await surface('IMG.CR3.xmp', MAPLE_EDIT)).toEqual([
      'IMG (conflict from move).xmp',
      'IMG.CR3',
    ]);
    expect(await listPairedSidecars(path.join(dir, 'IMG.CR3'))).toEqual([
      path.join(dir, 'IMG (conflict from move).xmp'),
    ]);
  });

  test('a name another file owns as its canonical sidecar stays that file’s', async () => {
    await fs.writeFile(path.join(dir, 'IMG.HEIC.JPG'), 'photo');

    expect(await surface('IMG.HEIC.xmp', MAPLE_EDIT)).toEqual([
      'IMG.HEIC (conflict from move).xmp',
      'IMG.HEIC.JPG',
    ]);
    expect(await listPairedSidecars(path.join(dir, 'IMG.HEIC.JPG'))).toEqual([
      path.join(dir, 'IMG.HEIC (conflict from move).xmp'),
    ]);
  });

  test('a video keeps its full file name, the name of its canonical sidecar', async () => {
    await fs.writeFile(path.join(dir, 'clip.mov'), 'video');

    expect(await surface('clip.mov.xmp', MAPLE_EDIT)).toEqual([
      'clip.mov',
      'clip.mov (conflict from move).xmp',
    ]);
  });
});
