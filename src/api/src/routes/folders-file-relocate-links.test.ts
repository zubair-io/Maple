import { expect, test } from 'bun:test';
import * as path from 'node:path';
import * as fs from '../fs/mirrored';
import { recoveryFixture } from '../cloud-backup/restore.test-helpers';
import { insertFolder } from '../db/sqlite/test-sqlite.test-helpers';
import { relocateRequestedFile } from './folders-file-relocate';

test('moving a sidecar symlink preserves its target and removes only the requested entry', async () => {
  const f = await recoveryFixture();
  try {
    insertFolder(f.live.db, { path: f.root });
    const target = path.join(f.root, 'target.xmp');
    const source = path.join(f.root, 'alias.xmp');
    const destination = path.join(f.root, 'moved.xmp');
    await fs.writeFile(target, '<edits/>');
    await fs.symlink(target, source);
    const result = await relocateRequestedFile({
      libraryRoot: f.root,
      sourceAbsPath: source,
      destAbsPath: destination,
      mode: 'move',
      collision: 'replace',
      rawSidecar: true,
    });
    expect(result).toMatchObject({ outcome: { kind: 'relocated' } });
    expect(await fs.readFile(target, 'utf8')).toBe('<edits/>');
    expect(await fs.readFile(destination, 'utf8')).toBe('<edits/>');
    await expect(fs.lstat(source)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test('a non-XMP destination symlink is replaced without changing the original photo it targets', async () => {
  const f = await recoveryFixture();
  try {
    insertFolder(f.live.db, { path: f.root });
    const original = path.join(f.root, 'photo.dng');
    const source = path.join(f.root, 'edits.xmp');
    const destination = path.join(f.root, 'archive.bak');
    await fs.writeFile(original, 'original photo');
    await fs.writeFile(source, '<edits/>');
    await fs.symlink(original, destination);
    const result = await relocateRequestedFile({
      libraryRoot: f.root,
      sourceAbsPath: source,
      destAbsPath: destination,
      mode: 'move',
      collision: 'replace',
      rawSidecar: true,
    });
    expect(result).toMatchObject({ outcome: { kind: 'relocated' } });
    expect(await fs.readFile(original, 'utf8')).toBe('original photo');
    expect(await fs.readFile(destination, 'utf8')).toBe('<edits/>');
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(false);
  } finally {
    await f.close();
  }
});
