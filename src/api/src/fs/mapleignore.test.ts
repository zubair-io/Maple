/** `.mapleignore` verdicts (#5398) against real temporary directories. */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IgnoreVerdictMemo,
  directoryHasIgnoreMarker,
  ignoreVerdict,
  ignoreVerdictForDir,
  ignoreVerdictForFile,
  listingHasIgnoreMarker,
} from './mapleignore.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});

function tree(...dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'maple-ignore-verdict-'));
  roots.push(root);
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

describe('ignoreVerdict', () => {
  it('finds a marker on the directory itself, an ancestor, or the root', async () => {
    const root = tree('a/b/c', 'other');
    expect(await ignoreVerdict(root, 'a/b/c')).toBe('indexed');
    writeFileSync(join(root, 'a', '.mapleignore'), '');
    expect(await ignoreVerdict(root, 'a')).toBe('ignored');
    expect(await ignoreVerdict(root, 'a/b/c')).toBe('ignored');
    expect(await ignoreVerdict(root, 'other')).toBe('indexed');
    writeFileSync(join(root, '.mapleignore'), '');
    expect(await ignoreVerdict(root, '')).toBe('ignored');
    expect(await ignoreVerdict(root, 'other')).toBe('ignored');
  });

  it('does not match a sibling whose name only shares a prefix', async () => {
    const root = tree('photos', 'photos2');
    writeFileSync(join(root, 'photos', '.mapleignore'), '');
    expect(await ignoreVerdict(root, 'photos2')).toBe('indexed');
  });

  it('answers for a directory that does not exist yet from its existing ancestors', async () => {
    const root = tree('a');
    expect(await ignoreVerdict(root, 'a/new/deeper')).toBe('indexed');
    writeFileSync(join(root, 'a', '.mapleignore'), '');
    expect(await ignoreVerdict(root, 'a/new/deeper')).toBe('ignored');
  });

  it('reports a marker it cannot stat as unknown, never as ignored', async () => {
    if (process.getuid?.() === 0) return; // root ignores permission bits
    const root = tree('locked/inner');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      expect(await ignoreVerdict(root, 'locked/inner')).toBe('unknown');
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });

  it('treats paths outside the root as indexed and resolves files by their directory', async () => {
    const root = tree('a');
    writeFileSync(join(root, 'a', '.mapleignore'), '');
    expect(await ignoreVerdictForFile(root, join(root, 'a', 'x.jpg'))).toBe('ignored');
    expect(await ignoreVerdictForFile(root, join(root, 'x.jpg'))).toBe('indexed');
    expect(await ignoreVerdictForDir(root, join(root, '..'))).toBe('indexed');
    expect(await directoryHasIgnoreMarker(join(root, 'a'))).toBe(true);
    expect(await directoryHasIgnoreMarker(root)).toBe(false);
  });

  it('counts only a regular file: not a directory, not a symlink', async () => {
    const root = tree('dir/.mapleignore', 'link');
    expect(await ignoreVerdict(root, 'dir')).toBe('indexed');
    symlinkSync(join(root, 'nowhere'), join(root, 'link', '.mapleignore'));
    expect(await ignoreVerdict(root, 'link')).toBe('indexed');
    expect(await listingHasIgnoreMarker(join(root, 'link'), ['.mapleignore'])).toBe(false);
    const marked = tree('m');
    writeFileSync(join(marked, 'm', '.mapleignore'), '');
    expect(await listingHasIgnoreMarker(join(marked, 'm'), ['a.jpg', '.mapleignore'])).toBe(true);
    expect(await listingHasIgnoreMarker(join(marked, 'm'), ['a.jpg'])).toBe(false);
  });

  it('memoizes per root and directory', async () => {
    const root = tree('a');
    const memo = new IgnoreVerdictMemo();
    expect(await memo.verdict(root, 'a')).toBe('indexed');
    writeFileSync(join(root, 'a', '.mapleignore'), '');
    expect(await memo.verdict(root, 'a')).toBe('indexed');
    expect(await new IgnoreVerdictMemo().verdict(root, 'a')).toBe('ignored');
  });
});
