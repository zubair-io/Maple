/**
 * Filesystem tests for the `_duplicates` mover. Real temp dirs (no Mongo) —
 * always run. Mirrors the trash-move contract: relocate the original + its
 * paired XMP sidecars, never overwrite an existing quarantined file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDuplicatesPath, moveToDuplicates, DUPLICATES_DIR_NAME } from './duplicates.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maple_dup_'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('computeDuplicatesPath', () => {
  it('maps <root>/<rel> to <root>/_duplicates/<rel>', () => {
    expect(computeDuplicatesPath(join(root, 'a/b/IMG.dng'), root)).toBe(
      join(root, DUPLICATES_DIR_NAME, 'a/b/IMG.dng'),
    );
  });

  it('handles a trailing slash on the root', () => {
    expect(computeDuplicatesPath(join(root, 'IMG.dng'), root + '/')).toBe(
      join(root, DUPLICATES_DIR_NAME, 'IMG.dng'),
    );
  });

  it('throws when the path is not under the root', () => {
    expect(() => computeDuplicatesPath('/elsewhere/IMG.dng', root)).toThrow();
  });

  it('throws for a sibling root that merely shares a name prefix (#3094)', () => {
    // `<root>` is a raw string prefix of `<root>2`, so an unbounded prefix
    // check would quarantine a neighbouring library's file into this root.
    expect(() => computeDuplicatesPath(root + '2/IMG.dng', root)).toThrow();
  });
});

describe('moveToDuplicates', () => {
  it('moves the file and its paired sidecars, preserving relative layout', async () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'IMG.dng'), 'raw-bytes');
    writeFileSync(join(root, 'sub', 'IMG.xmp'), '<xmp/>');
    writeFileSync(join(root, 'sub', 'IMG (conflict from Mac).xmp'), '<xmp conflict/>');

    const res = await moveToDuplicates(join(root, 'sub', 'IMG.dng'), root);

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.newAbsPath).toBe(join(root, DUPLICATES_DIR_NAME, 'sub', 'IMG.dng'));

    // Original gone; quarantined copy + both sidecars present alongside it.
    expect(existsSync(join(root, 'sub', 'IMG.dng'))).toBe(false);
    expect(existsSync(join(root, 'sub', 'IMG.xmp'))).toBe(false);
    expect(readFileSync(res.newAbsPath, 'utf8')).toBe('raw-bytes');
    expect(existsSync(join(root, DUPLICATES_DIR_NAME, 'sub', 'IMG.xmp'))).toBe(true);
    expect(existsSync(join(root, DUPLICATES_DIR_NAME, 'sub', 'IMG (conflict from Mac).xmp'))).toBe(
      true,
    );
  });

  it('never overwrites an existing quarantined file — suffixes .N', async () => {
    writeFileSync(join(root, 'IMG.dng'), 'first');
    const a = await moveToDuplicates(join(root, 'IMG.dng'), root);
    expect(a.kind).toBe('ok');

    // A second file with the same name lands at the same quarantine path.
    writeFileSync(join(root, 'IMG.dng'), 'second');
    const b = await moveToDuplicates(join(root, 'IMG.dng'), root);
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') return;

    expect(b.newAbsPath).not.toBe(a.newAbsPath);
    expect(b.newAbsPath).toBe(join(root, DUPLICATES_DIR_NAME, 'IMG.1.dng'));
    // Both copies survive — nothing clobbered.
    expect(readFileSync(a.newAbsPath, 'utf8')).toBe('first');
    expect(readFileSync(b.newAbsPath, 'utf8')).toBe('second');
  });

  it('errors (does not throw) when the source file is absent', async () => {
    const res = await moveToDuplicates(join(root, 'nope.dng'), root);
    expect(res.kind).toBe('error');
  });
});
