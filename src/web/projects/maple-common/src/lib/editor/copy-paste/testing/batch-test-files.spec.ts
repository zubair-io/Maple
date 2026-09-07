import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DiskBatchLedger } from './batch-test-files';

it('removes the temporary ledger file when its real atomic rename fails', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'maple-ledger-cleanup-'));
  try {
    const assets = join(root, 'assets');
    const destination = join(assets, 'photo.json');
    await fs.mkdir(destination, { recursive: true });
    const ledger = new DiskBatchLedger(root);

    await expect(
      ledger.saveAsset({ id: 'photo', operationId: 'operation', status: 'pending' }),
    ).rejects.toThrow();

    expect(await fs.readdir(assets)).toEqual(['photo.json']);
    expect((await fs.stat(destination)).isDirectory()).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
