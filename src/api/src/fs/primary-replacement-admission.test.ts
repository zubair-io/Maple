import { expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs/promises';
import * as fs from './mirrored';
import * as os from 'node:os';
import * as path from 'node:path';
import { primaryReplacementKey } from './primary-replacement-admission';

test('replacement keys follow directory aliases through missing ancestors but keep the final symlink name', async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'maple-replacement-key-')),
  );
  try {
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    await fs.mkdir(real);
    await fs.symlink(real, alias);
    expect(await primaryReplacementKey(path.join(alias, 'missing', 'photo.dng'))).toBe(
      await primaryReplacementKey(path.join(real, 'missing', 'photo.dng')),
    );
    const target = path.join(real, 'target.dng');
    const named = path.join(alias, 'photo.dng');
    await fs.writeFile(target, 'original');
    const before = await primaryReplacementKey(named);
    await fs.symlink(target, named);
    expect(await primaryReplacementKey(named)).toBe(before);
    expect(before).not.toBe(await primaryReplacementKey(target));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const code of ['EIO', 'EACCES']) {
  test(`replacement keys reject ${code} instead of splitting a directory alias identity`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-key-error-')));
    const target = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias);
    const realpath = nodeFs.realpath;
    const failure = Object.assign(new Error('transient directory lookup failure'), { code });
    const probe = spyOn(nodeFs, 'realpath').mockImplementation((async (
      file: Parameters<typeof nodeFs.realpath>[0],
    ) => {
      if (String(file) === alias) throw failure;
      return realpath(file);
    }) as typeof nodeFs.realpath);
    try {
      await expect(primaryReplacementKey(path.join(alias, 'photo.dng'))).rejects.toBe(failure);
      probe.mockRestore();
      expect(await primaryReplacementKey(path.join(alias, 'photo.dng'))).toBe(
        await primaryReplacementKey(path.join(target, 'photo.dng')),
      );
    } finally {
      probe.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
