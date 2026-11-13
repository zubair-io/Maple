import { afterEach, expect, test } from 'bun:test';
import * as fs from '../../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverRemovalForDiscover } from './removal-recovery.ts';

let root: string | undefined;
afterEach(async () => {
  if (!root) return;
  await fs.chmod(join(root, 'locked'), 0o700).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

test.skipIf(process.getuid?.() === 0)(
  'a journal probe that cannot stat the folder never stops the ordinary discover event',
  async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-discover-probe-')));
    await fs.mkdir(join(root, 'locked'));
    await fs.chmod(join(root, 'locked'), 0o000);
    expect(await recoverRemovalForDiscover(join(root, 'locked', 'x.dng'), root)).toBe(true);
  },
);
