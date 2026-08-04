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
});
