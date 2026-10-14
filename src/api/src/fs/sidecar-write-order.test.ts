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

  test('case-only sidecar aliases share a chain on case-insensitive platforms', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-case-'));
    try {
      let active = 0;
      let maxActive = 0;
      const job = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      };
      await Promise.all([
        serializeSidecarWrite(path.join(root, 'photo.xmp'), job),
        serializeSidecarWrite(path.join(root, 'PHOTO.xmp'), job),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('same destination preserves strict FIFO order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-fifo-'));
    try {
      const destination = path.join(root, 'a.xmp');
      const order: string[] = [];
      const job = (label: string) => async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(label);
        return label;
      };
      const results = await Promise.all([
        serializeSidecarWrite(destination, job('first')),
        serializeSidecarWrite(destination, job('second')),
        serializeSidecarWrite(destination, job('third')),
      ]);
      expect(results).toEqual(['first', 'second', 'third']);
      expect(order).toEqual(['first', 'second', 'third']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
