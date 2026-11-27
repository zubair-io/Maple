/**
 * copy.ts integration tests — real temp dirs, no database.
 *
 * Covers: atomic copy (parent dirs created, no temp left behind, source
 * untouched), identical-content skip, and distinct-content sibling fallback.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mirroredFs, * as mirrored from '../fs/mirrored.ts';
import { clearMirrorRoots, setMirrorRoots } from '../fs/mirror-registry.ts';
import { otelLogStream } from '../otel-logs.ts';
import { copyFileAtomic, resolveDest, destAbsPath } from './copy.ts';

const RUNS_AS_ROOT = process.getuid?.() === 0;

let dir: string;
let src: string;
let lib: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-imports-copy-'));
  src = path.join(dir, 'src.dng');
  lib = path.join(dir, 'lib');
  await fs.writeFile(src, 'the original bytes');
  await fs.mkdir(lib, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('copyFileAtomic', () => {
  test('creates parent dirs and copies bytes, leaving the source intact', async () => {
    const dest = path.join(lib, '2024', '03', 'src.dng');
    expect(await copyFileAtomic(src, dest)).toBe(true);
    expect(await fs.readFile(dest, 'utf8')).toBe('the original bytes');
    expect(await fs.readFile(src, 'utf8')).toBe('the original bytes');
  });

  test('imports a read-only original without changing its bytes or mode', async () => {
    const dest = path.join(lib, 'readonly.dng');
    await fs.chmod(src, 0o444);
    expect(await copyFileAtomic(src, dest)).toBe(true);
    expect(await fs.readFile(src, 'utf8')).toBe('the original bytes');
    expect(await fs.readFile(dest, 'utf8')).toBe('the original bytes');
    expect((await fs.stat(src)).mode & 0o777).toBe(0o444);
    expect((await fs.stat(dest)).mode & 0o777).toBe(0o444);
  });

  test('leaves no temp sibling behind', async () => {
    const destDir = path.join(lib, '2024', '03');
    const dest = path.join(destDir, 'src.dng');
    await copyFileAtomic(src, dest);
    const entries = await fs.readdir(destDir);
    expect(entries).toEqual(['src.dng']);
  });

  test('never clobbers — returns false when the destination already exists', async () => {
    const dest = path.join(lib, '2024', '03', 'src.dng');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'a pre-existing file');
    expect(await copyFileAtomic(src, dest)).toBe(false);
    // The existing file is untouched, and no temp sibling is left behind.
    expect(await fs.readFile(dest, 'utf8')).toBe('a pre-existing file');
    expect(await fs.readdir(path.dirname(dest))).toEqual(['src.dng']);
  });
});

describe('copyFileAtomic temp files', () => {
  test('a copy that fails part-way removes its partial temp file', async () => {
    const dest = path.join(lib, '2024', '03', 'src.dng');
    const copying = spyOn(mirroredFs, 'copyFile').mockImplementationOnce(async (_src, tmp) => {
      await fs.writeFile(String(tmp), 'a partial co');
      throw new Error('disk full');
    });
    try {
      await expect(copyFileAtomic(src, dest)).rejects.toThrow('disk full');
    } finally {
      copying.mockRestore();
    }
    expect(await fs.readdir(path.dirname(dest))).toEqual([]);
  });

  test.skipIf(RUNS_AS_ROOT)(
    'a temp file that cannot be removed is logged with its path and does not fail the copy',
    async () => {
      const dest = path.join(lib, '2024', '03', 'src.dng');
      const folder = path.dirname(dest);
      await fs.mkdir(folder, { recursive: true });
      const records: Record<string, unknown>[] = [];
      const logged = spyOn(otelLogStream, 'write').mockImplementation((line: string) => {
        records.push(JSON.parse(line) as Record<string, unknown>);
      });
      const linking = spyOn(mirrored, 'link').mockImplementationOnce(async () => {
        await fs.chmod(folder, 0o555);
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      });
      try {
        expect(await copyFileAtomic(src, dest)).toBe(false);
      } finally {
        linking.mockRestore();
        logged.mockRestore();
        await fs.chmod(folder, 0o755);
      }

      const leftover = (await fs.readdir(folder)).map((name) => path.join(folder, name));
      expect(leftover).toHaveLength(1);
      const warning = records.find(
        (record) => record.component === 'import-copy' && record.level === 40,
      );
      expect(warning?.tmp).toBe(leftover[0]);
      expect(String(warning?.err)).toContain('EACCES');
    },
  );
});

describe('copyFileAtomic when the link is reported as name taken', () => {
  const taken = () => Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
  const dest = () => path.join(lib, '2024', '03', 'src.dng');

  const ownLinkReportedTaken = () =>
    spyOn(mirrored, 'link').mockImplementationOnce(async (existing, created) => {
      await fs.link(existing, created);
      throw taken();
    });

  const lstatReporting = (changes: { ino?: bigint; nlink?: bigint }) =>
    spyOn(mirroredFs, 'lstat').mockImplementation((async (file: string, options: object) => {
      const stats = await fs.lstat(file, options);
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, changes);
    }) as unknown as typeof mirroredFs.lstat);

  test("this copy's own link, still under two names, counts as published and leaves one name", async () => {
    const linking = ownLinkReportedTaken();
    try {
      expect(await copyFileAtomic(src, dest())).toBe(true);
    } finally {
      linking.mockRestore();
    }
    expect(await fs.readFile(dest(), 'utf8')).toBe('the original bytes');
    expect(await fs.readdir(path.dirname(dest()))).toEqual(['src.dng']);
  });

  test("another writer's file with the same bytes is not this copy's own", async () => {
    const linking = spyOn(mirrored, 'link').mockImplementationOnce(async () => {
      await fs.writeFile(dest(), 'the original bytes');
      throw taken();
    });
    try {
      expect(await copyFileAtomic(src, dest())).toBe(false);
    } finally {
      linking.mockRestore();
    }
    expect(await fs.readdir(path.dirname(dest()))).toEqual(['src.dng']);
    expect((await fs.stat(dest())).nlink).toBe(1);
  });

  for (const [what, changes] of [
    ['an inode number of 0', { ino: 0n }],
    ['a link count of 1', { nlink: 1n }],
  ] as const) {
    test(`a filesystem reporting ${what} cannot prove the link is this copy's own`, async () => {
      const linking = ownLinkReportedTaken();
      const reporting = lstatReporting(changes);
      try {
        expect(await copyFileAtomic(src, dest())).toBe(false);
      } finally {
        reporting.mockRestore();
        linking.mockRestore();
      }
      expect(await fs.readdir(path.dirname(dest()))).toEqual(['src.dng']);
    });
  }

  test('the recognised own link is replicated to the backup mirror', async () => {
    const mirror = path.join(dir, 'mirror');
    await fs.mkdir(mirror);
    setMirrorRoots({ [lib]: [mirror] });
    const linking = ownLinkReportedTaken();
    try {
      expect(await copyFileAtomic(src, dest())).toBe(true);
      await mirrored.flushPendingMirrorOps();
    } finally {
      linking.mockRestore();
      clearMirrorRoots();
    }
    expect(await fs.readFile(path.join(mirror, '2024', '03', 'src.dng'), 'utf8')).toBe(
      'the original bytes',
    );
  });
});

describe('resolveDest', () => {
  test('returns the requested path when nothing is there', async () => {
    const r = await resolveDest(lib, '2024/03/src.dng', src);
    expect(r).toEqual({ destRel: '2024/03/src.dng', alreadyPresent: false });
  });

  test('flags alreadyPresent when identical content already exists', async () => {
    const dest = destAbsPath(lib, '2024/03/src.dng');
    await copyFileAtomic(src, dest);
    const r = await resolveDest(lib, '2024/03/src.dng', src);
    expect(r.alreadyPresent).toBe(true);
    expect(r.destRel).toBe('2024/03/src.dng');
  });

  test('picks a free sibling when different content occupies the path', async () => {
    const dest = destAbsPath(lib, '2024/03/src.dng');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'a DIFFERENT file with the same name');
    const r = await resolveDest(lib, '2024/03/src.dng', src);
    expect(r.alreadyPresent).toBe(false);
    expect(r.destRel).toBe('2024/03/src-1.dng');
  });
});
