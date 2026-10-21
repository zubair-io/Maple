/** A late save whose replace fails leaves no temp file behind (#5061). Real files in a temp dir. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from './mirrored.ts';
import { settleCarriedSidecar } from './sidecar-ownership.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-settle-cleanup-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('a late save whose replace fails leaves no temp file and keeps the source', async () => {
  const source = path.join(root, 'a', 'IMG.xmp');
  const dest = path.join(root, 'b', 'IMG.xmp');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, 'edit 1');
  await fs.writeFile(source, 'edit 2');
  const rename = spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EBUSY'));
  try {
    await expect(settleCarriedSidecar(source, dest, Buffer.from('edit 1'), false)).rejects.toThrow(
      'EBUSY',
    );
  } finally {
    rename.mockRestore();
  }

  expect(await fs.readdir(path.dirname(dest))).toEqual(['IMG.xmp']);
  expect(await fs.readFile(source, 'utf8')).toBe('edit 2');
});
