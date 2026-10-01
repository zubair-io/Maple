import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from './mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { moveOutOfTrash, pickFreeRestoredPath } from './trash.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-restore-safety-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function stagedPhoto(): Promise<{ primary: string; sidecar: string }> {
  const dir = path.join(root, '.maple', 'trash');
  await fs.mkdir(dir, { recursive: true });
  const primary = path.join(dir, 'photo.dng');
  const sidecar = path.join(dir, 'photo.xmp');
  await fs.writeFile(primary, 'trashed-original-pixels');
  await fs.writeFile(sidecar, '<xmp>trashed-edits</xmp>');
  return { primary, sidecar };
}

async function expectTrashUntouched(primary: string, sidecar: string): Promise<void> {
  expect(await fs.readFile(primary, 'utf8')).toBe('trashed-original-pixels');
  expect(await fs.readFile(sidecar, 'utf8')).toBe('<xmp>trashed-edits</xmp>');
}

describe('trash restore preserves occupants (#3992)', () => {
  test('exhaustion leaves the trashed photo, XMP and every occupied destination unchanged', async () => {
    const { primary, sidecar } = await stagedPhoto();
    const target = path.join(root, 'photo.dng');
    const targetSidecar = path.join(root, 'photo.xmp');
    await fs.writeFile(target, 'existing-original-pixels');
    await fs.writeFile(targetSidecar, '<xmp>existing-edits</xmp>');
    const candidates = Array.from({ length: 1001 }, (_, n) =>
      path.join(root, `photo.restored${n === 0 ? '' : `.${n}`}.dng`),
    );
    for (const candidate of candidates) await fs.writeFile(candidate, 'occupied');

    const result = await moveOutOfTrash(primary, target);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error).toMatch(/exceeded 1000/);
    await expectTrashUntouched(primary, sidecar);
    expect(await fs.readFile(target, 'utf8')).toBe('existing-original-pixels');
    expect(await fs.readFile(targetSidecar, 'utf8')).toBe('<xmp>existing-edits</xmp>');
    for (const candidate of candidates)
      expect(await fs.readFile(candidate, 'utf8')).toBe('occupied');
    expect((await fs.readdir(root)).some((name) => name.includes('.tmp.'))).toBe(false);
  });

  test('destination lookup errors become restore errors before copying or removing the source', async () => {
    const { primary, sidecar } = await stagedPhoto();
    const blocker = path.join(root, 'not-a-directory');
    await fs.writeFile(blocker, 'existing-file');
    const result = await moveOutOfTrash(primary, path.join(blocker, 'photo.dng'));
    expect(result.kind).toBe('error');
    await expectTrashUntouched(primary, sidecar);
    expect(await fs.readFile(blocker, 'utf8')).toBe('existing-file');
  });

  test('candidate lookup errors are not classified as free paths', async () => {
    const blocker = path.join(root, 'not-a-directory');
    await fs.writeFile(blocker, 'existing-file');
    await expect(pickFreeRestoredPath(path.join(blocker, 'photo.dng'))).rejects.toThrow();
    expect(await fs.readFile(blocker, 'utf8')).toBe('existing-file');
  });

  test.skipIf(process.platform === 'win32')(
    'a dangling original target remains intact and restore uses a suffix',
    async () => {
      const { primary } = await stagedPhoto();
      const target = path.join(root, 'photo.dng');
      const linkTarget = path.join(root, 'missing-original');
      await fs.symlink(linkTarget, target);
      const result = await moveOutOfTrash(primary, target);
      expect(result).toEqual({ kind: 'ok', newAbsPath: path.join(root, 'photo.restored.dng') });
      expect(await fs.readlink(target)).toBe(linkTarget);
      expect(await fs.readFile(path.join(root, 'photo.restored.xmp'), 'utf8')).toBe(
        '<xmp>trashed-edits</xmp>',
      );
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a dangling restored candidate is skipped without replacing its link',
    async () => {
      const { primary } = await stagedPhoto();
      const target = path.join(root, 'photo.dng');
      const candidate = path.join(root, 'photo.restored.dng');
      const linkTarget = path.join(root, 'missing-candidate');
      await fs.writeFile(target, 'existing-original-pixels');
      await fs.symlink(linkTarget, candidate);
      const result = await moveOutOfTrash(primary, target);
      expect(result).toEqual({ kind: 'ok', newAbsPath: path.join(root, 'photo.restored.1.dng') });
      expect(await fs.readlink(candidate)).toBe(linkTarget);
      expect(await fs.readFile(target, 'utf8')).toBe('existing-original-pixels');
      expect(await fs.readFile(path.join(root, 'photo.restored.1.xmp'), 'utf8')).toBe(
        '<xmp>trashed-edits</xmp>',
      );
    },
  );
});
