/** Trash, restore and the duplicates mover carry a photo's pre-#5021 old-name backup edit (#5063). Real files in a temp dir. */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from '../src/fs/mirrored.ts';
import { moveToDuplicates } from '../src/fs/duplicates.ts';
import * as ownership from '../src/fs/sidecar-ownership.ts';
import { moveOutOfTrash, moveToTrash } from '../src/fs/trash.ts';

const maple = (label: string) =>
  `<x:xmpmeta xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-trash-old-name-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test("trash and restore carry a photo's pre-#5021 IMG.HEIC.xmp with it", async () => {
  const dir = path.join(tmpRoot, 'old-name');
  await fs.mkdir(dir, { recursive: true });
  const photo = path.join(dir, 'IMG_5.HEIC');
  await fs.writeFile(photo, 'photo');
  await fs.writeFile(path.join(dir, 'IMG_5.HEIC.xmp'), maple('backup edit'));

  const trashed = await moveToTrash(photo, tmpRoot);
  expect(trashed.kind).toBe('ok');
  if (trashed.kind !== 'ok') return;
  await expect(fs.stat(path.join(dir, 'IMG_5.HEIC.xmp'))).rejects.toThrow();
  expect(await fs.readFile(`${trashed.newAbsPath}.xmp`, 'utf8')).toBe(maple('backup edit'));

  const restored = await moveOutOfTrash(trashed.newAbsPath, photo);
  expect(restored.kind).toBe('ok');
  expect(await fs.readFile(path.join(dir, 'IMG_5.HEIC.xmp'), 'utf8')).toBe(maple('backup edit'));
});

// The old-name file names one photo's full file name, so a same-stem sibling
// that still shares `IMG_6.xmp` never keeps a copy of it behind.
test('a RAW+JPEG sibling keeps the shared sidecar but not the old-name edit', async () => {
  const dir = path.join(tmpRoot, 'old-name-pair');
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'IMG_6.CR3');
  await fs.writeFile(raw, 'raw');
  await fs.writeFile(path.join(dir, 'IMG_6.JPG'), 'jpeg');
  await fs.writeFile(path.join(dir, 'IMG_6.xmp'), maple('shared edit'));
  await fs.writeFile(path.join(dir, 'IMG_6.CR3.xmp'), maple('backup edit'));

  const trashed = await moveToTrash(raw, tmpRoot);

  expect(trashed.kind).toBe('ok');
  if (trashed.kind !== 'ok') return;
  expect(await fs.readFile(path.join(dir, 'IMG_6.xmp'), 'utf8')).toBe(maple('shared edit'));
  await expect(fs.stat(path.join(dir, 'IMG_6.CR3.xmp'))).rejects.toThrow();
  expect(await fs.readFile(`${trashed.newAbsPath}.xmp`, 'utf8')).toBe(maple('backup edit'));
});

test('restoring one half of a trashed RAW+JPEG pair takes its old-name edit out of the trash', async () => {
  const dir = path.join(tmpRoot, 'old-name-pair-restore');
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'IMG_7.CR3');
  const jpeg = path.join(dir, 'IMG_7.JPG');
  await fs.writeFile(raw, 'raw');
  await fs.writeFile(jpeg, 'jpeg');
  await fs.writeFile(path.join(dir, 'IMG_7.xmp'), maple('shared edit'));
  await fs.writeFile(path.join(dir, 'IMG_7.CR3.xmp'), maple('backup edit'));
  const trashedRaw = await moveToTrash(raw, tmpRoot);
  const trashedJpeg = await moveToTrash(jpeg, tmpRoot);
  if (trashedRaw.kind !== 'ok' || trashedJpeg.kind !== 'ok') throw new Error('trash failed');

  const restored = await moveOutOfTrash(trashedRaw.newAbsPath, raw);

  expect(restored.kind).toBe('ok');
  expect(await fs.readFile(path.join(dir, 'IMG_7.CR3.xmp'), 'utf8')).toBe(maple('backup edit'));
  await expect(fs.stat(`${trashedRaw.newAbsPath}.xmp`)).rejects.toThrow();
});

test('the duplicates mover takes the old-name edit even when a same-stem sibling stays', async () => {
  const dir = path.join(tmpRoot, 'old-name-pair-duplicate');
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'IMG_8.CR3');
  await fs.writeFile(raw, 'raw');
  await fs.writeFile(path.join(dir, 'IMG_8.JPG'), 'jpeg');
  await fs.writeFile(path.join(dir, 'IMG_8.CR3.xmp'), maple('backup edit'));

  const moved = await moveToDuplicates(raw, tmpRoot);

  expect(moved.kind).toBe('ok');
  if (moved.kind !== 'ok') return;
  expect(await fs.readFile(`${moved.newAbsPath}.xmp`, 'utf8')).toBe(maple('backup edit'));
  await expect(fs.stat(path.join(dir, 'IMG_8.CR3.xmp'))).rejects.toThrow();
});

test("restore won't land the edit on a name a file that arrived meanwhile owns", async () => {
  const dir = path.join(tmpRoot, 'old-name-restore-claimed');
  await fs.mkdir(dir, { recursive: true });
  const photo = path.join(dir, 'IMG_9.HEIC');
  await fs.writeFile(photo, 'photo');
  await fs.writeFile(path.join(dir, 'IMG_9.HEIC.xmp'), maple('backup edit'));
  const trashed = await moveToTrash(photo, tmpRoot);
  if (trashed.kind !== 'ok') throw new Error('trash failed');
  await fs.writeFile(path.join(dir, 'IMG_9.HEIC.JPG'), 'export');

  const restored = await moveOutOfTrash(trashed.newAbsPath, photo);

  expect(restored.kind).toBe('ok');
  if (restored.kind !== 'ok') return;
  expect(restored.newAbsPath).not.toBe(photo);
  await expect(fs.stat(path.join(dir, 'IMG_9.HEIC.xmp'))).rejects.toThrow();
  expect(await fs.readFile(`${restored.newAbsPath}.xmp`, 'utf8')).toBe(maple('backup edit'));
});

// Root reads a mode-000 file anyway, so there is nothing to refuse.
test.skipIf(process.getuid?.() === 0)(
  "the duplicates mover refuses a photo whose old-name edit can't be read",
  async () => {
    const dir = path.join(tmpRoot, 'old-name-unreadable-duplicate');
    await fs.mkdir(dir, { recursive: true });
    const raw = path.join(dir, 'IMG_10.HEIC');
    await fs.writeFile(raw, 'photo');
    const legacy = path.join(dir, 'IMG_10.HEIC.xmp');
    await fs.writeFile(legacy, maple('backup edit'));
    await fs.chmod(legacy, 0o000);
    try {
      const moved = await moveToDuplicates(raw, tmpRoot);

      expect(moved.kind).toBe('error');
      expect(await fs.readFile(raw, 'utf8')).toBe('photo');
    } finally {
      await fs.chmod(legacy, 0o644);
    }
  },
);

test("the duplicates mover moves nothing when the old-name edit can't be carried", async () => {
  const dir = path.join(tmpRoot, 'old-name-duplicate-carry-fails');
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'IMG_11.HEIC');
  await fs.writeFile(raw, 'photo');
  await fs.writeFile(path.join(dir, 'IMG_11.HEIC.xmp'), maple('backup edit'));
  const publish = spyOn(ownership, 'publishSidecarSnapshot').mockRejectedValueOnce(
    new Error('EIO'),
  );
  try {
    const moved = await moveToDuplicates(raw, tmpRoot);

    expect(moved.kind).toBe('error');
  } finally {
    publish.mockRestore();
  }
  expect(await fs.readFile(raw, 'utf8')).toBe('photo');
  expect(await fs.readFile(path.join(dir, 'IMG_11.HEIC.xmp'), 'utf8')).toBe(maple('backup edit'));
});

test('the duplicates mover carries a save that lands after it copied the old-name edit ahead', async () => {
  const dir = path.join(tmpRoot, 'old-name-duplicate-late-save');
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'IMG_12.HEIC');
  const legacy = path.join(dir, 'IMG_12.HEIC.xmp');
  await fs.writeFile(raw, 'photo');
  await fs.writeFile(legacy, maple('backup edit'));
  const realSettle = ownership.settleCarriedSidecar;
  const rename = spyOn(ownership, 'settleCarriedSidecar').mockImplementationOnce(
    async (source, dest, snapshot, keepSource) => {
      await fs.writeFile(legacy, maple('late save'));
      return realSettle(source, dest, snapshot, keepSource);
    },
  );
  try {
    const moved = await moveToDuplicates(raw, tmpRoot);

    expect(moved.kind).toBe('ok');
    if (moved.kind !== 'ok') return;
    expect(await fs.readFile(`${moved.newAbsPath}.xmp`, 'utf8')).toBe(maple('late save'));
  } finally {
    rename.mockRestore();
  }
  await expect(fs.stat(legacy)).rejects.toThrow();
});

test('restore keeps the trashed photo while its old-name edit stays in the trash', async () => {
  const dir = path.join(tmpRoot, 'old-name-restore-kept');
  await fs.mkdir(dir, { recursive: true });
  const photo = path.join(dir, 'IMG_13.HEIC');
  await fs.writeFile(photo, 'photo');
  await fs.writeFile(`${photo}.xmp`, maple('backup edit'));
  const trashed = await moveToTrash(photo, tmpRoot);
  expect(trashed.kind).toBe('ok');
  if (trashed.kind !== 'ok') return;

  const restored = await moveOutOfTrash(
    trashed.newAbsPath,
    photo,
    undefined,
    undefined,
    async () => {
      await fs.writeFile(`${trashed.newAbsPath}.xmp`, maple('saved in the trash'));
      await fs.writeFile(`${photo}.xmp`, maple('saved at the restored path'));
    },
  );

  expect(restored.kind).toBe('ok');
  expect(await fs.readFile(`${trashed.newAbsPath}.xmp`, 'utf8')).toBe(maple('saved in the trash'));
  expect(await fs.readFile(trashed.newAbsPath, 'utf8')).toBe('photo');
});

test('the duplicates mover keeps the photo while its old-name edit stays behind', async () => {
  const dir = path.join(tmpRoot, 'old-name-duplicate-kept');
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'IMG_14.HEIC');
  const legacy = `${raw}.xmp`;
  await fs.writeFile(raw, 'photo');
  await fs.writeFile(legacy, maple('backup edit'));
  const realSettle = ownership.settleCarriedSidecar;
  const settle = spyOn(ownership, 'settleCarriedSidecar').mockImplementationOnce(
    async (source, dest, snapshot, keepSource) => {
      await fs.writeFile(source, maple('saved at the old path'));
      await fs.writeFile(dest, maple('saved at the new path'));
      return realSettle(source, dest, snapshot, keepSource);
    },
  );
  try {
    const moved = await moveToDuplicates(raw, tmpRoot);

    expect(moved.kind).toBe('ok');
  } finally {
    settle.mockRestore();
  }
  expect(await fs.readFile(legacy, 'utf8')).toBe(maple('saved at the old path'));
  expect(await fs.readFile(raw, 'utf8')).toBe('photo');
});
