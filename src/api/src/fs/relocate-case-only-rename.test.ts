/**
 * Dedicated unit tests for the case-only-rename special case (#2704),
 * split out of `relocate.test.ts` (which was already over its file-size
 * budget headroom before this ticket) to keep both files under
 * CONTRIBUTING.md's 570-line ceiling on a changed file.
 *
 * Alongside the corpus case (`relocate.parity.test.ts`'s
 * `case_only_rename_file_succeeds_with_sidecar`) — the corpus intentionally
 * only proves cross-platform OUTCOME parity, not full coverage of this
 * module's own mechanics (onVerified wiring, failure direction, the
 * copy-mode refusal). Skipped outright on a case-SENSITIVE volume: there
 * `img.cr3` -> `IMG.CR3` is an ordinary rename to a different name and never
 * enters this code path at all.
 *
 * Real temp directories, real files, real sidecars — no mocks for the
 * filesystem or sidecar layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { relocateFile } from './relocate.ts';

/** Probed live (write `a`, stat `A`), same technique as
 * `relocate.parity.test.ts`'s `CASE_INSENSITIVE_FS` — CI can mount a
 * case-sensitive volume on any OS, so this must never be assumed from
 * `process.platform`. Synchronous and evaluated once at module load so the
 * `test.skipIf` calls below can use it directly. */
const CASE_INSENSITIVE_FS: boolean = (() => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'relocate-case-probe-'));
  try {
    fsSync.writeFileSync(path.join(dir, 'a'), 'x');
    return fsSync.existsSync(path.join(dir, 'A'));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-case-only-'));
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
/** No file at `rel` has a `.tmp.` sibling left behind — a leaked temp would
 * mean a failed relocate didn't clean up after itself. */
async function hasNoTempLitter(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(root, dir));
  } catch {
    return;
  }
  expect(entries.some((n) => n.includes('.tmp.'))).toBe(false);
}

describe('relocateFile — case-only rename (#2704)', () => {
  test.skipIf(!CASE_INSENSITIVE_FS)(
    'auto-suffix collision renames IN PLACE instead of suffixing to a .1 duplicate-looking name',
    async () => {
      await write('a/img.cr3', 'pixels');
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/img.cr3'),
        destAbsPath: abs('a/IMG.CR3'),
        mode: 'move',
        collision: 'auto-suffix', // the default an asset-rename caller actually uses
      });
      expect(outcome.kind).toBe('relocated');
      if (outcome.kind !== 'relocated') return;
      // Before the fix: `pathExists` read the target as occupied (by the
      // source itself, via case-insensitive lookup) and auto-suffixed to
      // `IMG.1.CR3` instead of performing the intended rename.
      expect(outcome.newAbsPath).toBe(abs('a/IMG.CR3'));
      expect(outcome.renamedOnCollision).toBe(false);
      expect(await exists('a/IMG.1.CR3')).toBe(false);
      expect(await read('a/IMG.CR3')).toBe('pixels');
      await hasNoTempLitter('a'); // no staged copy — this is a direct fs.rename
    },
  );

  test.skipIf(!CASE_INSENSITIVE_FS)(
    'the sidecar follows the primary, renamed to the new casing',
    async () => {
      await write('a/img.cr3', 'pixels');
      await write('a/img.xmp', 'edits');
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/img.cr3'),
        destAbsPath: abs('a/IMG.CR3'),
        mode: 'move',
        collision: 'auto-suffix',
      });
      expect(outcome.kind).toBe('relocated');
      if (outcome.kind !== 'relocated') return;
      expect(outcome.sidecarPaths).toEqual([abs('a/IMG.xmp')]);
      expect(await read('a/IMG.xmp')).toBe('edits');
    },
  );

  test.skipIf(!CASE_INSENSITIVE_FS)(
    'onVerified runs with the new (renamed) path and sidecar list',
    async () => {
      await write('a/img.cr3', 'pixels');
      await write('a/img.xmp', 'edits');
      const captured: { info?: { newAbsPath: string; sidecarPaths: string[] } } = {};
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/img.cr3'),
        destAbsPath: abs('a/IMG.CR3'),
        mode: 'move',
        collision: 'auto-suffix',
        onVerified: async (info) => {
          captured.info = info;
        },
      });
      expect(outcome.kind).toBe('relocated');
      expect(captured.info).toEqual({
        newAbsPath: abs('a/IMG.CR3'),
        sidecarPaths: [abs('a/IMG.xmp')],
      });
    },
  );

  test.skipIf(!CASE_INSENSITIVE_FS)(
    'a failed onVerified reverts the primary AND sidecar back to their original casing (failure direction)',
    async () => {
      await write('a/img.cr3', 'pixels');
      await write('a/img.xmp', 'edits');
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/img.cr3'),
        destAbsPath: abs('a/IMG.CR3'),
        mode: 'move',
        collision: 'auto-suffix',
        onVerified: async () => {
          throw new Error('boom — simulated DB repoint failure');
        },
      });
      expect(outcome.kind).toBe('error');
      // Reverted: the file is back at its ORIGINAL casing, byte-identical.
      // (A plain `exists('a/IMG.CR3')` can't distinguish "reverted" from
      // "left at the new casing" here — a case-insensitive filesystem
      // resolves EITHER query to the same single on-disk entry — so this
      // reads the directory listing directly to confirm the STORED name.)
      expect(await exists('a/img.cr3')).toBe(true);
      expect(await read('a/img.cr3')).toBe('pixels');
      expect(await exists('a/img.xmp')).toBe(true);
      expect(await read('a/img.xmp')).toBe('edits');
      const storedNames = await fs.readdir(abs('a'));
      expect(storedNames.sort()).toEqual(['img.cr3', 'img.xmp']);
    },
  );

  test.skipIf(!CASE_INSENSITIVE_FS)(
    'mode: copy onto a case-only-different target is refused rather than copying the file onto itself',
    async () => {
      await write('a/img.cr3', 'pixels');
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/img.cr3'),
        destAbsPath: abs('a/IMG.CR3'),
        mode: 'copy',
        collision: 'auto-suffix',
      });
      expect(outcome.kind).toBe('error');
      expect(await exists('a/img.cr3')).toBe(true);
      expect(await read('a/img.cr3')).toBe('pixels');
    },
  );
});

// ---------------------------------------------------------------------------
// Case-SENSITIVE filesystem: two genuinely distinct files whose names
// differ only by case must NOT be misclassified as a case-only rename
// (review on #2704 — a pure string-comparison classification would
// misidentify this pair on ext4/CI and let a direct `fs.rename` silently
// clobber the destination's real content). Skipped outright on a
// case-INSENSITIVE volume: there it's impossible to even create two such
// files — the second write just overwrites the first.
// ---------------------------------------------------------------------------

describe('relocateFile — case-SENSITIVE filesystem: distinct same-case-insensitive-name files are never conflated', () => {
  test.skipIf(CASE_INSENSITIVE_FS)(
    'a genuinely different file that merely shares a case-insensitive name is refused, never clobbered',
    async () => {
      await write('a/img.cr3', 'source-pixels');
      await write('a/IMG.CR3', 'unrelated-destination-pixels');
      const outcome = await relocateFile({
        sourceAbsPath: abs('a/img.cr3'),
        destAbsPath: abs('a/IMG.CR3'),
        mode: 'move',
        collision: 'auto-suffix',
      });
      // NOT 'relocated' via a same-file direct rename — auto-suffix collision
      // handling must run instead, since these are two real, different files.
      expect(outcome.kind).toBe('relocated');
      if (outcome.kind !== 'relocated') return;
      expect(outcome.renamedOnCollision).toBe(true);
      // The load-bearing assertion: the unrelated destination file's
      // content survives untouched, and the source's content lands at the
      // auto-suffixed path — not clobbering IMG.CR3.
      expect(await read('a/IMG.CR3')).toBe('unrelated-destination-pixels');
      expect(await exists('a/img.cr3')).toBe(false); // source moved (mode: move)
    },
  );
});
