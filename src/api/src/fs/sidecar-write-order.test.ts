import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { serializeSidecarWrite } from './sidecar-write-order';

describe('serializeSidecarWrite', () => {
  test('aliased paths for one file share a single chain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-'));
    try {
      const realDir = path.join(root, 'real');
      await fs.mkdir(realDir);
      const linkDir = path.join(root, 'link');
      await fs.symlink(realDir, linkDir, 'dir');
      let active = 0;
      let maxActive = 0;
      const order: string[] = [];
      const job = (label: string) => async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(label);
        active--;
        return label;
      };
      const results = await Promise.all([
        serializeSidecarWrite(path.join(realDir, 'a.xmp'), job('real-1')),
        serializeSidecarWrite(path.join(linkDir, 'a.xmp'), job('link-1')),
        serializeSidecarWrite(path.join(realDir, 'a.xmp'), job('real-2')),
      ]);
      expect(results.toSorted()).toEqual(['link-1', 'real-1', 'real-2']);
      expect(maxActive).toBe(1);
      expect(order.toSorted()).toEqual(['link-1', 'real-1', 'real-2']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
