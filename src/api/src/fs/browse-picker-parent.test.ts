import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from './mirrored.ts';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { listDir } from './browse.ts';

describe('filesystem picker parent stays inside allowed roots', () => {
  let directory: string;
  let root: string;
  const prior = process.env.MAPLE_ROOTS;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'maple-picker-parent-')));
    root = join(directory, 'photos');
    await mkdir(join(root, 'nested'), { recursive: true });
    process.env.MAPLE_ROOTS = root;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = prior;
    await rm(directory, { recursive: true, force: true });
  });

  it('offers no parent above a permitted root, but keeps navigation within it', async () => {
    const atRoot = await listDir(root, false);
    expect(atRoot.ok).toBe(true);
    expect(atRoot.data?.parent).toBeNull();
    expect(atRoot.data?.entries.map((entry) => entry.path)).toContain(join(root, 'nested'));
    const nested = await listDir(join(root, 'nested'), false);
    expect(nested.data?.parent).toBe(root);
    expect((await listDir(directory, false)).ok).toBe(false);
  });

  it('does not treat a sibling sharing the root prefix as an allowed ancestor', async () => {
    const sibling = join(directory, 'photos-outside');
    await mkdir(sibling);
    expect((await listDir(sibling, false)).ok).toBe(false);
    expect((await listDir(root, false)).data?.parent).toBeNull();
  });

  it('can navigate into a broader permitted root when roots overlap', async () => {
    process.env.MAPLE_ROOTS = [root, directory].join(delimiter);
    expect((await listDir(root, false)).data?.parent).toBe(directory);
  });

  it.skipIf(process.platform === 'win32')(
    'uses the canonical boundary of a symlinked root',
    async () => {
      const alias = join(directory, 'alias');
      await symlink(root, alias);
      process.env.MAPLE_ROOTS = alias;
      const listed = await listDir(alias, false);
      expect(listed.data?.path).toBe(root);
      expect(listed.data?.parent).toBeNull();
    },
  );
});
