import { expect, test } from 'bun:test';
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
