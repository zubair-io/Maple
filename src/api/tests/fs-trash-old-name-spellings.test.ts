/**
 * A photo with two spellings of its old-name edit (`IMG.HEIC.xmp` and `img.heic.xmp`
 * on a case-sensitive volume) keeps every one through restore and purge (#5087).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from '../src/db/object-id.ts';
import * as fs from '../src/fs/mirrored.ts';
import { moveOutOfTrash, moveToTrash } from '../src/fs/trash.ts';
import { unlinkTrashedCopy } from '../src/library/trashed-copy.ts';

const CASE_INSENSITIVE_FS: boolean = (() => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'spelling-probe-'));
  try {
    fsSync.writeFileSync(path.join(dir, 'a'), 'x');
    return fsSync.existsSync(path.join(dir, 'A'));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
})();

const maple = (label: string) =>
  `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-old-name-spellings-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function trashWithTwoSpellings(name: string) {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(dir, { recursive: true });
  const photo = path.join(dir, 'IMG_1.HEIC');
  await fs.writeFile(photo, 'photo');
  await fs.writeFile(`${photo}.xmp`, maple('first spelling'));
  const trashed = await moveToTrash(photo, tmpRoot);
  if (trashed.kind !== 'ok') throw new Error('trash failed');
  const second = path.join(path.dirname(trashed.newAbsPath), 'img_1.heic.xmp');
  await fs.writeFile(second, maple('second spelling'));
  return { dir, photo, trashed: trashed.newAbsPath, second };
}

async function xmpBodies(dir: string): Promise<string[]> {
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.xmp'));
  return (await Promise.all(names.map((name) => fs.readFile(path.join(dir, name), 'utf8')))).sort();
}

test.skipIf(CASE_INSENSITIVE_FS)(
  'restore brings every spelling of the old-name edit back and empties the trash',
  async () => {
    const { dir, photo, trashed } = await trashWithTwoSpellings('restore');

    const restored = await moveOutOfTrash(trashed, photo);

    expect(restored.kind).toBe('ok');
    expect(await xmpBodies(dir)).toEqual([maple('first spelling'), maple('second spelling')]);
    expect(await fs.readdir(path.dirname(trashed))).toEqual([]);
  },
);

test.skipIf(CASE_INSENSITIVE_FS)('a purge erases every spelling of the old-name edit', async () => {
  const { trashed } = await trashWithTwoSpellings('purge');

  const failures = await unlinkTrashedCopy(
    {
      absPath: trashed,
      libraryRoot: tmpRoot,
      location: { library_id: new ObjectId(), path: '', filename: 'IMG_1.HEIC' },
      isPrimary: true,
      survivor: null,
    },
    () => {},
    async () => {},
  );

  expect(failures).toBe(0);
  expect(await fs.readdir(path.dirname(trashed))).toEqual([]);
});
