/**
 * copy.ts integration tests — real temp dirs, no Mongo.
 *
 * Covers: atomic copy (parent dirs created, no temp left behind, source
 * untouched), identical-content skip, and distinct-content sibling fallback.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyFileAtomic, resolveDest, destAbsPath } from './copy.ts';

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
