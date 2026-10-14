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
      expect(results).toEqual(['real-1', 'link-1', 'real-2']);
      expect(maxActive).toBe(1);
      expect(order).toEqual(['real-1', 'link-1', 'real-2']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('case-only sidecar aliases share a chain on every host', async () => {
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

  test('different destinations can write concurrently', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-serialize-parallel-'));
    try {
      let started = 0;
      let releaseWrites!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        releaseWrites = resolve;
      });
      const write = async () => {
        started++;
        if (started === 2) releaseWrites();
        await bothStarted;
      };

      await Promise.all([
        serializeSidecarWrite(path.join(root, 'a.xmp'), write),
        serializeSidecarWrite(path.join(root, 'b.xmp'), write),
      ]);
      expect(started).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
