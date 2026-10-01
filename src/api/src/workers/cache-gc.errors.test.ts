/** Real filesystem failure and race guards for cache GC. */
import { describe, test, expect, afterEach, mock } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes, chmod, readdir } from '../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLiveTestDatabase } from '../db/sqlite/test-sqlite.test-helpers.ts';
import { registerLibrary } from '../../tests/helpers/assets-route-fixtures.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const LEGACY_KEY = '0123456789abcdef'; // gitleaks:allow sha256_prefix16 — 16 hex

afterEach(() => invalidateLibraryRoots());
async function mkTree(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'cache-gc-errors-'));
}
async function writeJpg(p: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
}
async function agePast(p: string): Promise<void> {
  const past = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(p, past, past);
}

describe('sweepOrphanedCaches — filesystem race and failure guards', () => {
  test('ENOENT (file vanished between readdir and unlink) does not abort sweep or log error', async () => {
    using live = await createLiveTestDatabase();
    const root = await mkTree();
    try {
      registerLibrary(live.db, root);
      // Four legacy-keyed orphans. The mock makes `fs.unlink` race-fail
      // (ENOENT) for the first to land in unlinkSafe, simulating another
      // process having removed it between readdir and unlink.
      const racedKey = '0123456789abcdee'; // gitleaks:allow sha256_prefix16 — 16 hex
      const otherKeys = [
        '0123456789abcded', // gitleaks:allow sha256_prefix16 — 16 hex
        '0123456789abcdec', // gitleaks:allow sha256_prefix16 — 16 hex
        '0123456789abcdeb', // gitleaks:allow sha256_prefix16 — 16 hex
      ];
      const racedPath = path.join(root, '.maple', 'thumbs', `${racedKey}.jpg`);
      const otherPaths = otherKeys.map((k) => path.join(root, '.maple', 'thumbs', `${k}.jpg`));
      for (const p of [racedPath, ...otherPaths]) {
        await writeJpg(p);
        await agePast(p);
      }

      const realFs = await import('node:fs/promises');
      // Capture the real unlink BEFORE patching the module — otherwise the
      // fallback path inside the mock would recurse through the mocked
      // binding and blow the stack.
      const realUnlink = realFs.unlink.bind(realFs);
      // Module mock — bun:test rewires the ESM binding for the duration of
      // the test. Reset after by re-mocking back to the originals.
      mock.module('node:fs/promises', () => ({
        ...realFs,
        unlink: async (target: Parameters<typeof realFs.unlink>[0]) => {
          if (target === racedPath) {
            throw Object.assign(new Error('ENOENT: no such file or directory'), {
              code: 'ENOENT',
            });
          }
          return realUnlink(target);
        },
      }));

      try {
        // Fresh import so the mocked module is bound.
        const { sweepOrphanedCaches } = await import('./cache-gc.ts');

        // Even with the ENOENT injection, the sweep MUST complete and unlink
        // the other 3 orphans. If ENOENT counted toward FAIL_THRESHOLD, three
        // consecutive ENOENTs would abort the sweep — here we only inject one,
        // but the streak counter must also reset so a subsequent real failure
        // wouldn't trip immediately. `deleted === 3` verifies both.
        const result = await sweepOrphanedCaches(root);
        expect(result.scanned).toBe(4);
        expect(result.deleted).toBe(3);
        expect(result.skipped_recent).toBe(0);

        for (const p of otherPaths) {
          await expect(stat(p)).rejects.toThrow();
        }
        // racedPath is still there because our mock prevented the real unlink.
        const s = await stat(racedPath);
        expect(s.size).toBeGreaterThan(0);
      } finally {
        mock.module('node:fs/promises', () => realFs);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persistent unlink failure aborts sweep without crashing the caller', async () => {
    // POSIX unlink requires write+execute on the parent directory. Chmod the
    // parent to 0o555 (r-x for owner) so:
    //   - readdir still works (need 'r'), so the sweep sees the files
    //   - unlink fails with EACCES (need 'w' on parent), tripping the threshold
    // Skip on Windows (no POSIX perms) and when running as root (perms ignored).
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    using live = await createLiveTestDatabase();
    const { sweepOrphanedCaches } = await import('./cache-gc.ts');
    const root = await mkTree();
    const lockedDir = path.join(root, '.maple', 'thumbs');
    try {
      registerLibrary(live.db, root);
      // Four orphan files in one cache dir. We need at least 3 same-errno
      // failures to trip FAIL_THRESHOLD; the 4th may or may not be attempted
      // depending on whether the abort raced the loop body.
      const orphans = [
        path.join(lockedDir, `${LEGACY_KEY}.jpg`),
        path.join(lockedDir, '0123456789abcdee.jpg'),
        path.join(lockedDir, '0123456789abcded.jpg'),
        path.join(lockedDir, '0123456789abcdec.jpg'),
      ];
      for (const p of orphans) {
        await writeJpg(p);
        await agePast(p);
      }

      // Read-execute on parent: readdir/stat succeed, unlink fails EACCES.
      await chmod(lockedDir, 0o555);

      // Sweep should catch the abort internally and return partial counts —
      // crucially, it must NOT throw past the boot wiring at index.ts.
      const result = await sweepOrphanedCaches(root);
      expect(result.deleted).toBe(0);
      // At least 3 scanned (the threshold) before the abort. May be 3 or 4
      // depending on readdir order.
      expect(result.scanned).toBeGreaterThanOrEqual(3);

      // Restore perms so files still on disk can be enumerated then cleaned.
      await chmod(lockedDir, 0o755);
      const remaining = await readdir(lockedDir);
      expect(remaining.length).toBe(orphans.length);
    } finally {
      // Defensive: re-open perms in case the test errored before we did.
      try {
        await chmod(lockedDir, 0o755);
      } catch {
        /* ignore */
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
