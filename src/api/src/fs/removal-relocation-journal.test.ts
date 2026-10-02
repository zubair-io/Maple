/** #1472: real SIGKILL, durable RAW/XMP/asset bytes and isolated native render. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from './mirrored.ts';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { maple } from 'maple';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { relocateFile } from './relocate.ts';
import { removalJournalPath, recoverRemovalRelocation } from './removal-relocation-journal.ts';
import { writeXmpAtomic, writeXmpWithPrecondition, deleteXmpSidecar } from './xmp.ts';
import { writeConflictSidecarAtomic, deleteConflictSidecar } from './xmp-conflict.ts';
import { registerRoot, unregisterRoot } from './root.ts';

const fixture = resolve(import.meta.dir, '../../../../test-fixtures/removal/calibration');
describe.skipIf(!nativeLibAvailable())('Removal relocation process-loss recovery (#1472)', () => {
  let root: string;
  let source: string;
  let target: string;
  let sourceXmp: string;
  let targetXmp: string;
  let xml: string;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-removal-recovery-')));
    registerRoot(root);
    source = join(root, 'source/photo.dng');
    target = join(root, 'destination/renamed.dng');
    sourceXmp = source.replace('.dng', '.xmp');
    targetXmp = target.replace('.dng', '.xmp');
    for (const raw of [source, target])
      await fs.mkdir(join(dirname(raw), '.maple/inpaint'), { recursive: true });
    await fs.copyFile(join(fixture, 'source.dng'), source);
    await fs.copyFile(join(fixture, 'saved.xmp'), sourceXmp);
    xml = await fs.readFile(sourceXmp, 'utf8');
    const [record] = JSON.parse(await fs.readFile(join(fixture, 'records.txt'), 'utf8'));
    for (const raw of [source, target]) {
      const assets = join(dirname(raw), '.maple/inpaint');
      await fs.copyFile(
        join(fixture, 'mask.mimf'),
        join(assets, `${record.accepted.mask.slice(7)}.mask`),
      );
      await fs.copyFile(join(fixture, 'patch.f16'), join(assets, `${record.patch.slice(7)}.f16`));
    }
    await fs.writeFile(target, 'previous original');
    await fs.writeFile(targetXmp, 'previous sidecar');
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
    await fs.rm(root, { recursive: true, force: true });
    unregisterRoot(root);
  });
  afterAll(() => ffiPool().shutdown());

  async function owner(phase: string) {
    let accept!: () => void;
    const started = new Promise<void>((resolveReady) => {
      accept = resolveReady;
    });
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'removal-relocation-crash.fixture.ts'),
        source,
        target,
        phase,
      ],
      {
        stdout: 'ignore',
        stderr: 'pipe',
        ipc(message) {
          if (message && typeof message === 'object' && 'ready' in message) accept();
        },
      },
    );
    children.push(child);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      await Promise.race([
        started,
        child.exited.then(async (code) => {
          throw new Error(
            `Crash fixture exited before ready (${code}): ${await new Response(child.stderr).text()}`,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    return child;
  }
  async function crash(phase: string) {
    const child = await owner(phase);
    child.kill('SIGKILL');
    await child.exited;
    expect(child.signalCode).toBe('SIGKILL');
    expect(await fs.stat(removalJournalPath(target))).toBeDefined();
  }
  async function assertSource() {
    expect(await fs.readFile(source)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    expect(await fs.readFile(sourceXmp, 'utf8')).toBe(xml);
  }
  async function assertClean() {
    expect(
      (await fs.readdir(dirname(target))).filter(
        (name) => name.endsWith('.rollback') || name.endsWith('.removal-relocation.json'),
      ),
    ).toEqual([]);
  }
  async function assertSavedPixels() {
    const output = join(root, 'recovered.png');
    expect(
      await ffiPool().exportRecipeToFile(
        target,
        xml,
        JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, format: 'png', quality: null }),
        null,
        output,
      ),
    ).toBe(true);
    expect(Buffer.from((await maple(output).toRaw()).data)).toEqual(
      await fs.readFile(join(fixture, 'preview-64.rgb')),
    );
  }

  it('live owner rejects recovery and a competing replacement without changing bytes', async () => {
    const child = await owner('partial');
    await expect(recoverRemovalRelocation(target)).rejects.toThrow('busy');
    const competing = await relocateFile({
      sourceAbsPath: source,
      destAbsPath: target,
      mode: 'move',
      collision: 'replace',
    });
    expect(competing.kind).toBe('error');
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
    await assertSource();
    child.kill('SIGKILL');
    await child.exited;
    await recoverRemovalRelocation(target);
    expect(await fs.readFile(target, 'utf8')).toBe('previous original');
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
    await assertClean();
  }, 30_000);

  for (const phase of ['prepared', 'partial'])
    it(`SIGKILL at ${phase} restores the previous pair and keeps the incoming edit`, async () => {
      await crash(phase);
      await recoverRemovalRelocation(target);
      expect(await fs.readFile(target, 'utf8')).toBe('previous original');
      expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
      await assertSource();
      await assertClean();
      await recoverRemovalRelocation(target);
    }, 30_000);

  it('SIGKILL after production publication retains verified saved pixels and the source', async () => {
    await crash('complete');
    await recoverRemovalRelocation(target);
    expect(await fs.readFile(targetXmp, 'utf8')).toBe(xml);
    await assertSavedPixels();
    await assertSource();
    await assertClean();
  }, 30_000);

  it('a complete publication recovers even when its source directory no longer exists', async () => {
    await crash('complete');
    await fs.rm(dirname(source), { recursive: true });
    await recoverRemovalRelocation(target);
    await assertSavedPixels();
    await assertClean();
  }, 30_000);

  it('retry recovers a partial replacement before resolving its collision', async () => {
    await crash('partial');
    const skipped = await relocateFile({
      sourceAbsPath: source,
      destAbsPath: target,
      mode: 'copy',
      collision: 'skip',
    });
    expect(skipped.kind).toBe('skipped');
    expect(await fs.readFile(target, 'utf8')).toBe('previous original');
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
    await assertSource();
    await assertClean();
  }, 30_000);

  it('a partial create-only publication rolls back before retrying the actual copy', async () => {
    await fs.unlink(target);
    await fs.unlink(targetXmp);
    await crash('partial');
    const result = await relocateFile({
      sourceAbsPath: source,
      destAbsPath: target,
      mode: 'copy',
      collision: 'skip',
    });
    expect(result.kind).toBe('relocated');
    await assertSavedPixels();
    await assertSource();
    await assertClean();
  }, 30_000);

  it('completed production publication recovers all conflict sidecars', async () => {
    const sourceConflict = join(dirname(source), 'photo (conflict from iPad).xmp');
    const targetConflict = join(dirname(target), 'renamed (conflict from iPad).xmp');
    const staleConflict = join(dirname(target), 'renamed (conflict from retired).xmp');
    await fs.writeFile(sourceConflict, xml);
    await fs.writeFile(staleConflict, 'previous conflict');
    await crash('complete');
    await recoverRemovalRelocation(target);
    expect(await fs.readFile(targetConflict, 'utf8')).toBe(xml);
    expect(await fs.readFile(sourceConflict, 'utf8')).toBe(xml);
    await expect(fs.stat(staleConflict)).rejects.toThrow();
    await assertSavedPixels();
    await assertClean();
  }, 30_000);

  it('actual API canonical and conflict mutations refuse a live replacement owner', async () => {
    const child = await owner('partial');
    const conflict = join(dirname(target), 'renamed (conflict from iPad).xmp');
    await fs.writeFile(conflict, 'existing conflict');
    for (const raw of [source, target]) {
      expect((await writeXmpAtomic(raw, 'later canonical')).ok).toBe(false);
      expect((await writeXmpWithPrecondition(raw, 'later conflict', -1, 'iPad')).kind).toBe(
        'error',
      );
      expect((await deleteXmpSidecar(raw)).ok).toBe(false);
    }
    expect(
      (await writeConflictSidecarAtomic(target, 'renamed (conflict from iPad)', 'later conflict'))
        .ok,
    ).toBe(false);
    expect((await deleteConflictSidecar(target, 'renamed (conflict from iPad)')).ok).toBe(false);
    expect(await fs.readFile(conflict, 'utf8')).toBe('existing conflict');
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
    await assertSource();
    child.kill('SIGKILL');
    await child.exited;
  }, 30_000);

  for (const phase of ['partial', 'leased'])
    it(`an ordinary file cannot overwrite a ${phase} removal owner`, async () => {
      const child = await owner(phase);
      const ordinary = join(root, 'ordinary.dng');
      await fs.copyFile(join(fixture, 'source.dng'), ordinary);
      const result = await relocateFile({
        sourceAbsPath: ordinary,
        destAbsPath: target,
        mode: 'move',
        collision: 'replace',
      });
      expect(result.kind).toBe('error');
      expect(await fs.readFile(ordinary)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
      expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
      if (phase === 'leased') expect(await fs.readFile(target, 'utf8')).toBe('previous original');
      await assertSource();
      child.kill('SIGKILL');
      await child.exited;
    }, 30_000);

  it('saving after a crash recovers the previous pair before applying the new XMP', async () => {
    await crash('partial');
    expect((await writeXmpAtomic(target, 'new user edit')).ok).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('previous original');
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('new user edit');
    await assertSource();
    await assertClean();
  }, 30_000);

  it('cleanup resumes after one obsolete backup has already been removed', async () => {
    await crash('complete');
    const journal = JSON.parse(await fs.readFile(removalJournalPath(target), 'utf8'));
    await fs.unlink(join(dirname(target), journal.files[0].backup));
    await recoverRemovalRelocation(target);
    await assertSavedPixels();
    await assertSource();
    await assertClean();
  }, 30_000);

  it('an unavailable accepted patch blocks cleanup of a completed publication', async () => {
    await crash('complete');
    const assets = join(dirname(target), '.maple/inpaint');
    const name = (await fs.readdir(assets)).find((value) => value.endsWith('.f16'))!;
    await fs.unlink(join(assets, name));
    const journal = await fs.readFile(removalJournalPath(target));
    await expect(recoverRemovalRelocation(target)).rejects.toThrow();
    expect(await fs.readFile(removalJournalPath(target))).toEqual(journal);
    expect(await fs.readFile(targetXmp, 'utf8')).toBe(xml);
    await assertSource();
  }, 30_000);

  for (const changed of [
    'later-sidecar',
    'later-original',
    'backup',
    'missing-source',
    'missing-mask',
  ])
    it(`${changed} retains all recovery evidence and refuses destructive restoration`, async () => {
      await crash('partial');
      const journal = JSON.parse(await fs.readFile(removalJournalPath(target), 'utf8'));
      if (changed === 'later-sidecar') await fs.writeFile(targetXmp, 'later user edit');
      if (changed === 'later-original') await fs.writeFile(target, 'later original');
      if (changed === 'backup')
        await fs.writeFile(join(dirname(target), journal.files[0].backup), 'changed backup');
      if (changed === 'missing-source') await fs.unlink(source);
      if (changed === 'missing-mask') {
        const assets = join(dirname(source), '.maple/inpaint');
        const name = (await fs.readdir(assets)).find((value) => value.endsWith('.mask'))!;
        await fs.unlink(join(assets, name));
      }
      const before = await Promise.all(
        [target, targetXmp, removalJournalPath(target)].map((path) => fs.readFile(path)),
      );
      await expect(recoverRemovalRelocation(target)).rejects.toThrow();
      expect(
        await Promise.all(
          [target, targetXmp, removalJournalPath(target)].map((path) => fs.readFile(path)),
        ),
      ).toEqual(before);
      expect(
        (await fs.readdir(dirname(target))).filter((name) => name.endsWith('.rollback')).length,
      ).toBe(2);
    }, 30_000);

  it('rejects a journal backup escape before touching destination or outside files', async () => {
    await crash('partial');
    const outside = join(root, 'outside');
    await fs.writeFile(outside, 'outside bytes');
    const journal = JSON.parse(await fs.readFile(removalJournalPath(target), 'utf8'));
    journal.files[0].backup = `../${basename(outside)}`;
    await fs.writeFile(removalJournalPath(target), JSON.stringify(journal));
    await expect(recoverRemovalRelocation(target)).rejects.toThrow('Unrecognized');
    expect(await fs.readFile(outside, 'utf8')).toBe('outside bytes');
    expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
  }, 30_000);

  it('refuses a substituted recovery source that is the only incoming original', async () => {
    await crash('partial');
    const journal = JSON.parse(await fs.readFile(removalJournalPath(target), 'utf8'));
    journal.source = target;
    journal.sources[0].path = target;
    await fs.writeFile(removalJournalPath(target), JSON.stringify(journal));
    const incoming = await fs.readFile(target);
    await expect(recoverRemovalRelocation(target)).rejects.toThrow('separate retained');
    expect(await fs.readFile(target)).toEqual(incoming);
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
  }, 30_000);

  it('supports dot-prefixed photo names without treating them as journal internals', async () => {
    const hiddenSource = join(dirname(source), '.photo.dng');
    const hiddenTarget = join(dirname(target), '.renamed.dng');
    await fs.rename(source, hiddenSource);
    await fs.rename(sourceXmp, hiddenSource.replace('.dng', '.xmp'));
    await fs.rename(target, hiddenTarget);
    await fs.rename(targetXmp, hiddenTarget.replace('.dng', '.xmp'));
    source = hiddenSource;
    target = hiddenTarget;
    sourceXmp = hiddenSource.replace('.dng', '.xmp');
    targetXmp = hiddenTarget.replace('.dng', '.xmp');
    await crash('complete');
    await recoverRemovalRelocation(target);
    await assertSource();
    await assertSavedPixels();
    await assertClean();
  }, 30_000);

  it('a lock-file symlink cannot grant a lease or write outside the photo directory', async () => {
    const outside = join(root, 'outside');
    await fs.writeFile(outside, 'outside bytes');
    await fs.symlink(outside, join(dirname(target), `.${basename(target)}.relocation.lock`));
    const result = await relocateFile({
      sourceAbsPath: source,
      destAbsPath: target,
      mode: 'move',
      collision: 'replace',
    });
    expect(result.kind).toBe('error');
    expect(await fs.readFile(outside, 'utf8')).toBe('outside bytes');
    expect(await fs.readFile(target, 'utf8')).toBe('previous original');
    expect(await fs.readFile(targetXmp, 'utf8')).toBe('previous sidecar');
    await assertSource();
  }, 30_000);
});
