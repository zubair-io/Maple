/**
 * Integration tests for `fs/relocate.ts`'s `extraCompanionAbsPaths` (#2667) —
 * the non-sidecar companion support added so `relocateAsset` (and, through
 * it, the on-demand geo-relocate route) can carry a PhotoKit backup's
 * Apple-rendered JPEG (`apple_rendered_path`) alongside the primary +
 * sidecars. Split out of `relocate.test.ts` to keep that file under its
 * file-size budget headroom (CONTRIBUTING.md's 570-line ceiling on a
 * changed file), the same reason `relocate.parity.test.ts` and
 * `relocate-case-only-rename.test.ts` are their own files.
 *
 * Real temp directories, real files — no mocks (repo rule: "No mocks for
 * the sidecar layer in tests").
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { relocateFile } from './relocate.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-companion-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
  const target = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}
function abs(rel: string): string {
  return path.join(root, ...rel.split('/'));
}
async function exists(rel: string): Promise<boolean> {
  try {
    await fs.stat(abs(rel));
    return true;
  } catch {
    return false;
  }
}
async function read(rel: string): Promise<string> {
  return fs.readFile(abs(rel), 'utf8');
}

describe('relocateFile — extraCompanionAbsPaths (#2667)', () => {
  test('a companion sharing the primary base is base-swap renamed and follows on move', async () => {
    await write('src/IMG_1.dng', 'pixels');
    const companionAbs = await write('src/IMG_1.jpg', 'rendered-bytes');
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG_1.dng'),
      destAbsPath: abs('dst/IMG_1.dng'),
      mode: 'move',
      collision: 'auto-suffix',
      extraCompanionAbsPaths: [companionAbs],
    });
    expect(outcome.kind).toBe('relocated');
    if (outcome.kind !== 'relocated') return;
    expect(outcome.companionPaths).toEqual([abs('dst/IMG_1.jpg')]);
    expect(await exists('dst/IMG_1.jpg')).toBe(true);
    expect(await read('dst/IMG_1.jpg')).toBe('rendered-bytes');
    expect(await exists('src/IMG_1.jpg')).toBe(false);
  });

  test('a companion whose name does not share the primary base keeps its own name in the new dir', async () => {
    await write('src/IMG_1.dng', 'pixels');
    const companionAbs = await write('src/unrelated-rendered.jpg', 'rendered-bytes');
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG_1.dng'),
      destAbsPath: abs('dst/IMG_1.dng'),
      mode: 'move',
      collision: 'auto-suffix',
      extraCompanionAbsPaths: [companionAbs],
    });
    expect(outcome.kind).toBe('relocated');
    if (outcome.kind !== 'relocated') return;
    expect(outcome.companionPaths).toEqual([abs('dst/unrelated-rendered.jpg')]);
    expect(await exists('dst/unrelated-rendered.jpg')).toBe(true);
    expect(await exists('src/unrelated-rendered.jpg')).toBe(false);
  });

  test('collision auto-suffix renames the primary AND the companion consistently', async () => {
    await write('dst/IMG_1.dng', 'occupant'); // forces a .1 suffix
    await write('src/IMG_1.dng', 'pixels');
    const companionAbs = await write('src/IMG_1.jpg', 'rendered-bytes');
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG_1.dng'),
      destAbsPath: abs('dst/IMG_1.dng'),
      mode: 'move',
      collision: 'auto-suffix',
      extraCompanionAbsPaths: [companionAbs],
    });
    expect(outcome.kind).toBe('relocated');
    if (outcome.kind !== 'relocated') return;
    expect(outcome.newAbsPath).toBe(abs('dst/IMG_1.1.dng'));
    expect(await read('dst/IMG_1.1.jpg')).toBe('rendered-bytes');
    expect(await exists('src/IMG_1.jpg')).toBe(false);
  });

  test('mode: copy leaves the companion at BOTH locations', async () => {
    await write('src/IMG_1.dng', 'pixels');
    const companionAbs = await write('src/IMG_1.jpg', 'rendered-bytes');
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG_1.dng'),
      destAbsPath: abs('dst/IMG_1.dng'),
      mode: 'copy',
      collision: 'auto-suffix',
      extraCompanionAbsPaths: [companionAbs],
    });
    expect(outcome.kind).toBe('relocated');
    if (outcome.kind !== 'relocated') return;
    expect(await exists('dst/IMG_1.jpg')).toBe(true);
    expect(await exists('src/IMG_1.jpg')).toBe(true);
  });

  test('a companion copy failure is logged and left in place — never blocks or reverts the primary', async () => {
    await write('src/IMG_1.dng', 'pixels');
    const companionAbs = await write('src/IMG_1.jpg', 'rendered-bytes');
    await fs.chmod(companionAbs, 0o000);
    try {
      const outcome = await relocateFile({
        sourceAbsPath: abs('src/IMG_1.dng'),
        destAbsPath: abs('dst/IMG_1.dng'),
        mode: 'move',
        collision: 'auto-suffix',
        extraCompanionAbsPaths: [companionAbs],
      });
      expect(outcome.kind).toBe('relocated');
      if (outcome.kind !== 'relocated') return;
      expect(outcome.companionPaths).toEqual([]);
      expect(await exists('dst/IMG_1.dng')).toBe(true);
      expect(await exists('src/IMG_1.dng')).toBe(false);
      // Companion left in place at its ORIGINAL location, untouched.
      expect(await exists('src/IMG_1.jpg')).toBe(true);
    } finally {
      await fs.chmod(companionAbs, 0o644).catch(() => {});
    }
  });

  test('a companion that does not exist on disk is skipped without affecting the primary or sidecars', async () => {
    await write('src/IMG_1.dng', 'pixels');
    await write('src/IMG_1.xmp', 'edits');
    const outcome = await relocateFile({
      sourceAbsPath: abs('src/IMG_1.dng'),
      destAbsPath: abs('dst/IMG_1.dng'),
      mode: 'move',
      collision: 'auto-suffix',
      extraCompanionAbsPaths: [abs('src/IMG_1.jpg')], // never written
    });
    expect(outcome.kind).toBe('relocated');
    if (outcome.kind !== 'relocated') return;
    expect(outcome.companionPaths).toEqual([]);
    expect(outcome.sidecarPaths).toEqual([abs('dst/IMG_1.xmp')]);
    expect(await exists('dst/IMG_1.dng')).toBe(true);
  });
});
