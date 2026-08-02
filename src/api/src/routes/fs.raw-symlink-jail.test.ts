import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../db/client.ts';
import { fsRoutes } from './fs.ts';

/**
 * GET /api/fs/raw must never stream bytes from outside MAPLE_ROOTS.
 *
 * #926 replaced the handler's hard `realpath`-or-404 with `realpathOrResolve`,
 * which falls back to the UNRESOLVED path when `realpath` throws, so the
 * handler now re-resolves and re-checks the jail immediately before opening
 * the file it is about to stream.
 *
 * SCOPE — read this before trusting these tests as a security gate. They pin
 * the deterministic properties only:
 *
 *   - a symlink resolving outside a root is refused (guards the existing
 *     `isUnderRoot` check from regressing);
 *   - a symlink resolving INSIDE a root still serves, which is the regression
 *     the re-resolve could plausibly cause;
 *   - a genuine file still serves.
 *
 * They do NOT reproduce the TOCTOU race itself. Exploiting it requires the
 * link to be broken when `realpathOrResolve` runs and valid by the time the
 * stream opens; staging that interleaving deterministically needs a seam in
 * the handler that does not exist, and all three cases below pass with or
 * without the re-resolve. The race is closed by construction (the path that is
 * opened is the path that was checked), not by these assertions.
 */
const SHARED_DB = `maple_rawjail_test_${process.pid}`;

describe('GET /api/fs/raw — symlink jail', () => {
  let root: string | null = null;
  let outside: string | null = null;

  beforeEach(async () => {
    process.env.MAPLE_MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
    process.env.MAPLE_MONGO_DB = SHARED_DB;
    await closeDb();
    root = await realpath(await mkdtemp(join(tmpdir(), 'maple-rawjail-root-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'maple-rawjail-out-')));
    process.env.MAPLE_ROOTS = root;
    await writeFile(join(outside, 'secret.dng'), Buffer.from('TOP SECRET BYTES'));
    await writeFile(join(root, 'real.dng'), Buffer.from('legitimate'));
  });

  afterEach(async () => {
    for (const d of [root, outside]) {
      if (d) await rm(d, { recursive: true, force: true }).catch(() => {});
    }
    root = null;
    outside = null;
    await closeDb();
  });

  const app = () => new Elysia().use(fsRoutes);

  it('serves a genuine in-root file', async () => {
    const res = await app().handle(
      new Request(
        `http://localhost/api/fs/raw?path=${encodeURIComponent(join(root!, 'real.dng'))}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('legitimate');
  });

  it('refuses a symlink inside the root that points outside it', async () => {
    const link = join(root!, 'escape.dng');
    await symlink(join(outside!, 'secret.dng'), link);

    const res = await app().handle(
      new Request(`http://localhost/api/fs/raw?path=${encodeURIComponent(link)}`),
    );

    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('TOP SECRET');
  });

  it('still serves a symlink that resolves to another file inside the root', async () => {
    // The regression the re-resolve could introduce: legitimate in-root
    // symlinks must keep working. This one DOES exercise the new code path —
    // it reaches the primary branch and is re-resolved before opening.
    await writeFile(join(root!, 'target.dng'), Buffer.from('via-symlink'));
    const link = join(root!, 'alias.dng');
    await symlink(join(root!, 'target.dng'), link);

    const res = await app().handle(
      new Request(`http://localhost/api/fs/raw?path=${encodeURIComponent(link)}`),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('via-symlink');
  });

  it('refuses a broken symlink that is repointed out of the jail before the read', async () => {
    // A broken link is what drives `realpathOrResolve` down its fallback
    // branch — `realpath` throws, so the lexical (in-root) path is what the
    // jail check sees.
    const link = join(root!, 'swap.dng');
    await symlink(join(root!, 'does-not-exist.dng'), link);

    // The swap an attacker would perform between the check and the read.
    await unlink(link);
    await symlink(join(outside!, 'secret.dng'), link);

    const res = await app().handle(
      new Request(`http://localhost/api/fs/raw?path=${encodeURIComponent(link)}`),
    );

    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('TOP SECRET');
  });
});
