/**
 * `writeXmpWithPrecondition`'s `requireAbsent` mode — the create-only
 * precondition used by the FileProvider extension's `createItem` path
 * (Apple audit #2532). Passing `ifMtimeMatchesEpoch: null` alone means
 * "unconditional write" (used by modify-with-no-known-prior-version
 * callers), which is exactly wrong for a *create*: it silently clobbers
 * an XMP sidecar that already exists server-side but wasn't yet known to
 * the caller. `requireAbsent: true` makes that case a conflict instead.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeXmpWithPrecondition } from '../src/fs/xmp.ts';
import { writeSidecarCreateOnly } from '../src/fs/sidecar-io.ts';

let tmpRoot: string;
const PRIOR_ROOTS = process.env.MAPLE_ROOTS;

beforeAll(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-xmp-create-')));
  process.env.MAPLE_ROOTS = tmpRoot;
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (PRIOR_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = PRIOR_ROOTS;
});

describe('writeXmpWithPrecondition — requireAbsent (create-only)', () => {
  test('refuses to overwrite a sidecar that already exists — writes a conflict copy instead', async () => {
    const raw = path.join(tmpRoot, 'IMG_1.ARW');
    const xmpPath = path.join(tmpRoot, 'IMG_1.xmp');
    await fs.writeFile(xmpPath, '<x:xmpmeta>original</x:xmpmeta>');

    const outcome = await writeXmpWithPrecondition(
      raw,
      '<x:xmpmeta>from-a-create-that-thinks-this-is-new</x:xmpmeta>',
      null,
      'test-device',
      true, // requireAbsent
    );

    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('unreachable');
    expect(outcome.conflictPath).toContain('IMG_1 (conflict from test-device).xmp');

    const canonical = await fs.readFile(xmpPath, 'utf8');
    expect(canonical).toBe('<x:xmpmeta>original</x:xmpmeta>');
    const conflictContent = await fs.readFile(outcome.conflictPath, 'utf8');
    expect(conflictContent).toContain('from-a-create-that-thinks-this-is-new');
  });

  test('writes normally when no sidecar exists yet', async () => {
    const raw = path.join(tmpRoot, 'IMG_2.ARW');
    const xmpPath = path.join(tmpRoot, 'IMG_2.xmp');

    const outcome = await writeXmpWithPrecondition(
      raw,
      '<x:xmpmeta>brand-new</x:xmpmeta>',
      null,
      'test-device',
      true, // requireAbsent
    );

    expect(outcome.kind).toBe('ok');
    const onDisk = await fs.readFile(xmpPath, 'utf8');
    expect(onDisk).toBe('<x:xmpmeta>brand-new</x:xmpmeta>');
  });

  // #2784 — the atomic guarantee itself. A client-side "is it there yet?"
  // stat (like FileProviderExtensionCore's createOnlyPrecondition) is
  // inherently racy: two callers can both observe "absent" and both decide
  // to write. What must NOT be racy is this function: fired concurrently at
  // the same path with no serialization between them, exactly one call may
  // win the canonical file and every other call must see `exists`/conflict —
  // never two winners, and never a corrupted/interleaved file. A stat-then-
  // rename implementation (the shape this replaced) does not guarantee that:
  // both stats can observe "absent" before either rename lands.
  test('requireAbsent under true concurrency: exactly one of N simultaneous creates wins', async () => {
    const raw = path.join(tmpRoot, 'IMG_3.ARW');
    const xmpPath = path.join(tmpRoot, 'IMG_3.xmp');
    const N = 12;

    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeXmpWithPrecondition(
          raw,
          `<x:xmpmeta>writer-${i}</x:xmpmeta>`,
          null,
          `device-${i}`,
          true, // requireAbsent
        ),
      ),
    );

    const winners = outcomes.filter((o) => o.kind === 'ok');
    const conflicts = outcomes.filter((o) => o.kind === 'conflict');
    expect(winners.length).toBe(1);
    expect(conflicts.length).toBe(N - 1);

    // The canonical file holds exactly one writer's untouched content — no
    // interleaving/corruption from two writers racing the same destination.
    const canonical = await fs.readFile(xmpPath, 'utf8');
    expect(canonical).toMatch(/^<x:xmpmeta>writer-\d+<\/x:xmpmeta>$/);

    // Every loser's conflict copy exists, is a distinct file, and holds
    // exactly its own writer's content (no cross-writer corruption there
    // either).
    for (const o of conflicts) {
      if (o.kind !== 'conflict') continue;
      const content = await fs.readFile(o.conflictPath, 'utf8');
      expect(content).toMatch(/^<x:xmpmeta>writer-\d+<\/x:xmpmeta>$/);
    }
    const conflictPaths = new Set(
      conflicts.map((o) => (o.kind === 'conflict' ? o.conflictPath : '')),
    );
    expect(conflictPaths.size).toBe(N - 1); // every conflict copy landed at a distinct path
  });

  // Same guarantee one layer down, directly against the atomic primitive
  // `writeXmpWithPrecondition` delegates to — proves the `fs.link` EEXIST
  // race-freedom itself, independent of the conflict-copy fallback logic
  // layered on top in xmp.ts.
  test('writeSidecarCreateOnly under true concurrency: exactly one of N simultaneous links wins', async () => {
    const dest = path.join(tmpRoot, 'IMG_4.xmp');
    const N = 12;

    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeSidecarCreateOnly(dest, `writer-${i}`, 'test write failed'),
      ),
    );

    const winners = outcomes.filter((o) => o.ok);
    const losers = outcomes.filter((o) => !o.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(N - 1);
    expect(losers.every((o) => !o.ok && 'exists' in o && o.exists)).toBe(true);

    const onDisk = await fs.readFile(dest, 'utf8');
    expect(onDisk).toMatch(/^writer-\d+$/);
  });
});
