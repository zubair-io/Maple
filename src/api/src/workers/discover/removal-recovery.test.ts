/** #1472: actual SIGKILL publication recovery through the SQLite-backed discover sweep. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { maple } from 'maple';
import * as fs from '../../fs/mirrored.ts';
import { nativeLibAvailable } from '../../ffi/raw_ffi.ts';
import { ffiPool } from '../../ffi/ffi-pool.ts';
import { DEFAULT_EXPORT_RECIPE } from '../../generated/export-recipe.generated.ts';
import { createLiveTestDatabase, insertFolder } from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { ObjectId } from '../../db/object-id.ts';
import { removalJournalPath } from '../../fs/removal-relocation-journal.ts';
import { handleEvent } from './handle-event.ts';
import { locationsNamed, allAssets } from './discover.test-helpers.ts';
import { SweeperLoop, visitDirectory } from './sweeper.ts';
import * as frontier from './frontier.repo.ts';
import { startDiscover } from './index.ts';
import { patchDiscoverConfig } from './discover-config.repo.ts';
import { writeCheckpoint } from '../../db/repos/indexer-checkpoints.repo.ts';

const fixture = resolve(import.meta.dir, '../../../../../test-fixtures/removal/calibration');
describe.skipIf(!nativeLibAvailable())('Discover removal relocation recovery (#1472)', () => {
  let root: string;
  let source: string;
  let target: string;
  let xml: string;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-removal-discover-')));
    source = join(root, 'source/photo.dng');
    target = join(root, 'destination/renamed.dng');
    for (const raw of [source, target])
      await fs.mkdir(join(dirname(raw), '.maple/inpaint'), { recursive: true });
    await fs.copyFile(join(fixture, 'source.dng'), source);
    await fs.copyFile(join(fixture, 'saved.xmp'), source.replace('.dng', '.xmp'));
    xml = await fs.readFile(source.replace('.dng', '.xmp'), 'utf8');
    const [record] = JSON.parse(await fs.readFile(join(fixture, 'records.txt'), 'utf8'));
    for (const raw of [source, target]) {
      await fs.copyFile(
        join(fixture, 'mask.mimf'),
        join(dirname(raw), '.maple/inpaint', `${record.accepted.mask.slice(7)}.mask`),
      );
      await fs.copyFile(
        join(fixture, 'patch.f16'),
        join(dirname(raw), '.maple/inpaint', `${record.patch.slice(7)}.f16`),
      );
    }
    await fs.writeFile(target, 'previous original');
    await fs.writeFile(target.replace('.dng', '.xmp'), 'previous sidecar');
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  afterAll(() => ffiPool().shutdown());

  async function owner(phase: string) {
    let accept!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      accept = resolveReady;
    });
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, '../../fs/removal-relocation-crash.fixture.ts'),
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
        ready,
        child.exited.then(async (code) => {
          throw new Error(
            `Owner exited before ready (${code}): ${await new Response(child.stderr).text()}`,
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
  }
  async function visit(folderId: ObjectId) {
    await frontier.seedRoot(folderId, dirname(target), 3);
    const dir = await frontier.claimNextDir(folderId, 3, 60_000);
    await visitDirectory(dir!, root, { folderId, handleEvent });
  }
  async function assertSource() {
    expect(await fs.readFile(source)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    expect(await fs.readFile(source.replace('.dng', '.xmp'), 'utf8')).toBe(xml);
  }
  async function assertPixels() {
    expect(await fs.readFile(target)).toEqual(await fs.readFile(source));
    expect(await fs.readFile(target.replace('.dng', '.xmp'), 'utf8')).toBe(xml);
    const output = join(root, 'actual.png');
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

  it('a resumed sweep recovers complete production publication before adding its location', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await handleEvent({ kind: 'created', absPath: source }, folderId, root);
    const sourceId = locationsNamed(live.db, 'photo.dng')[0].asset_id;
    await crash('complete');
    await frontier.enqueueDirs(folderId, [dirname(target)], 3, false);
    const resumed = new SweeperLoop({
      folderId,
      root,
      startGen: 3,
      deps: { folderId, handleEvent },
      loadConfig: async () => ({ paused: false, sweepDirIntervalMs: 0 }),
      sleep: async () => {},
    });
    await resumed.runUntilIdleOrPaused();
    expect(locationsNamed(live.db, 'renamed.dng')[0].asset_id).toBe(sourceId);
    expect(allAssets(live.db)).toHaveLength(1);
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
    await assertPixels();
    await assertSource();
  }, 30_000);

  it('production discover startup resumes a persisted generation and settles recovery on stop', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await crash('complete');
    await frontier.enqueueDirs(folderId, [dirname(target)], 3, false);
    await writeCheckpoint({
      folderId: folderId.toHexString(),
      path: root,
      sweepGen: 3,
      lastWalkedAt: 0,
      inflightIds: [],
      updatedAt: 0,
    });
    await patchDiscoverConfig({ paused: false, sweepDirIntervalMs: 1 });
    const discover = await startDiscover({ roots: [root] });
    try {
      const deadline = Date.now() + 5_000;
      while (locationsNamed(live.db, 'renamed.dng').length === 0 && Date.now() < deadline)
        await Bun.sleep(10);
      expect(locationsNamed(live.db, 'renamed.dng')).toHaveLength(1);
    } finally {
      await discover.stop();
    }
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
    await assertPixels();
    await assertSource();
  }, 30_000);

  it('passive recovery accepts an intact source in a different registered library', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: dirname(target) }));
    insertFolder(live.db, { path: dirname(source) });
    await crash('partial');
    await frontier.seedRoot(folderId, dirname(target), 3);
    const dir = await frontier.claimNextDir(folderId, 3, 60_000);
    await visitDirectory(dir!, dirname(target), { folderId, handleEvent });
    expect(locationsNamed(live.db, 'renamed.dng')).toHaveLength(1);
    expect(await fs.readFile(target, 'utf8')).toBe('previous original');
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
    await assertSource();
  }, 30_000);

  for (const phase of ['prepared', 'partial'])
    it(`${phase} publication restores the previous pair before cataloguing it`, async () => {
      using live = await createLiveTestDatabase();
      const folderId = new ObjectId(insertFolder(live.db, { path: root }));
      await handleEvent({ kind: 'created', absPath: source }, folderId, root);
      await crash(phase);
      await visit(folderId);
      expect(await fs.readFile(target, 'utf8')).toBe('previous original');
      expect(await fs.readFile(target.replace('.dng', '.xmp'), 'utf8')).toBe('previous sidecar');
      expect(locationsNamed(live.db, 'renamed.dng')[0].asset_id).not.toBe(
        locationsNamed(live.db, 'photo.dng')[0].asset_id,
      );
      expect(allAssets(live.db)).toHaveLength(2);
      await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
      await assertSource();
    }, 30_000);

  it('active ownership defers only the affected photo and retries after process loss', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await fs.copyFile(source, join(dirname(target), 'safe.dng'));
    const child = await owner('partial');
    await visit(folderId);
    await handleEvent({ kind: 'created', absPath: target }, folderId, root);
    expect(locationsNamed(live.db, 'renamed.dng')).toEqual([]);
    expect(locationsNamed(live.db, 'safe.dng')).toHaveLength(1);
    expect(await fs.readFile(target.replace('.dng', '.xmp'), 'utf8')).toBe('previous sidecar');
    expect(await fs.stat(removalJournalPath(target))).toBeDefined();
    child.kill('SIGKILL');
    await child.exited;
    await visit(folderId);
    expect(locationsNamed(live.db, 'renamed.dng')).toHaveLength(1);
    expect(await fs.readFile(target, 'utf8')).toBe('previous original');
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
    await assertSource();
  }, 30_000);

  it('an absent primary with damaged evidence is not tagged missing', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await handleEvent({ kind: 'created', absPath: target }, folderId, root);
    await crash('partial');
    const journal = removalJournalPath(target);
    await fs.writeFile(journal, '{damaged recovery evidence');
    await fs.unlink(target);
    await visit(folderId);
    await handleEvent({ kind: 'removed', absPath: target }, folderId, root);
    expect(locationsNamed(live.db, 'renamed.dng')[0].missing_since).toBeNull();
    expect(await fs.readFile(journal, 'utf8')).toBe('{damaged recovery evidence');
    await assertSource();
  }, 30_000);

  it('a partial create-only publication is removed before the new-file partition', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await fs.unlink(target);
    await fs.unlink(target.replace('.dng', '.xmp'));
    await crash('partial');
    await visit(folderId);
    expect(locationsNamed(live.db, 'renamed.dng')).toEqual([]);
    await expect(fs.stat(target)).rejects.toThrow();
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
    await assertSource();
  }, 30_000);

  it('an unreadable listing after recovery defers catalogue changes without crashing the sweep', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await crash('partial');
    await frontier.seedRoot(folderId, dirname(target), 3);
    const dir = await frontier.claimNextDir(folderId, 3, 60_000);
    let reads = 0;
    await visitDirectory(dir!, root, {
      folderId,
      handleEvent,
      readDir: async (path) => {
        reads++;
        if (reads > 1) throw new Error('share listing temporarily unavailable');
        return fs.readdir(path, { withFileTypes: true });
      },
    });
    expect(reads).toBe(2);
    expect(locationsNamed(live.db, 'renamed.dng')).toEqual([]);
    expect(await frontier.remainingForGen(folderId, 3)).toBe(0);
    expect(await fs.readFile(target, 'utf8')).toBe('previous original');
    await visit(folderId);
    expect(locationsNamed(live.db, 'renamed.dng')).toHaveLength(1);
    await assertSource();
  }, 30_000);

  it('complete recovery works with a vanished source directory', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await crash('complete');
    await fs.rm(dirname(source), { recursive: true });
    await visit(folderId);
    expect(locationsNamed(live.db, 'renamed.dng')).toHaveLength(1);
    expect(await fs.readFile(target)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
  }, 30_000);

  it('a journal source outside registered libraries cannot create coordination files', async () => {
    using live = await createLiveTestDatabase();
    const folderId = new ObjectId(insertFolder(live.db, { path: root }));
    await crash('partial');
    const outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-removal-outside-')));
    try {
      const external = join(outside, basename(source));
      await fs.copyFile(source, external);
      const journal = removalJournalPath(target);
      const record = JSON.parse(await fs.readFile(journal, 'utf8'));
      record.sources = record.sources.map((value: { path: string; digest: string }) => ({
        ...value,
        path: value.path === source ? external : value.path,
      }));
      record.source = external;
      const evidence = JSON.stringify(record);
      await fs.writeFile(journal, evidence);
      await visit(folderId);
      expect(locationsNamed(live.db, 'renamed.dng')).toEqual([]);
      expect(await fs.readdir(outside)).toEqual([basename(source)]);
      expect(await fs.readFile(journal, 'utf8')).toBe(evidence);
      expect(await fs.readFile(target.replace('.dng', '.xmp'), 'utf8')).toBe('previous sidecar');
      await assertSource();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
