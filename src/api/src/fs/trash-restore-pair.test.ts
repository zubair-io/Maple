import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from './mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moveOutOfTrash } from './trash.ts';
import { sidecarRenameTarget } from './relocate.ts';
import { clearMirrorRoots, setMirrorRoots } from './mirror-registry.ts';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-restore-pair-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function stage(id: number, edited = true) {
  const dir = path.join(root, '.maple', 'trash', String(id));
  await fs.mkdir(dir, { recursive: true });
  const primary = path.join(dir, 'photo.dng');
  const sidecar = path.join(dir, 'photo.xmp');
  const pixels = `original-photo-${id}`;
  const edits = `<xmp><Exposure>${id}</Exposure></xmp>`;
  await fs.writeFile(primary, pixels);
  if (edited) await fs.writeFile(sidecar, edits);
  return { primary, sidecar, pixels, edits };
}

async function expectNoTemporaryFiles() {
  const entries = await fs.readdir(root, { recursive: true });
  expect(entries.filter((entry) => entry.includes('.tmp.'))).toEqual([]);
}

describe('restore publishes intact photo/XMP pairs (#3998)', () => {
  test('concurrent restores retain every distinct original with its own edits', async () => {
    const photos = await Promise.all(Array.from({ length: 12 }, (_, id) => stage(id)));
    const target = path.join(root, 'photo.dng');
    const outcomes = await Promise.all(
      photos.map((photo) => moveOutOfTrash(photo.primary, target)),
    );
    const destinations = new Set<string>();
    for (const [id, outcome] of outcomes.entries()) {
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') throw new Error(outcome.error);
      expect(destinations.has(outcome.newAbsPath)).toBe(false);
      destinations.add(outcome.newAbsPath);
      expect(await fs.readFile(outcome.newAbsPath, 'utf8')).toBe(photos[id].pixels);
      const sidecar = sidecarRenameTarget(
        photos[id].primary,
        outcome.newAbsPath,
        photos[id].sidecar,
      )!;
      expect(await fs.readFile(sidecar, 'utf8')).toBe(photos[id].edits);
      expect(await fs.exists(photos[id].primary)).toBe(false);
      expect(await fs.exists(photos[id].sidecar)).toBe(false);
    }
    expect(destinations.size).toBe(photos.length);
    await expectNoTemporaryFiles();
  });

  test('independent processes cannot replace each other during restoration', async () => {
    const photos = await Promise.all(Array.from({ length: 8 }, (_, id) => stage(id)));
    const target = path.join(root, 'photo.dng');
    const modulePath = fileURLToPath(new URL('./trash.ts', import.meta.url));
    const script = `import { moveOutOfTrash } from ${JSON.stringify(modulePath)};
      process.stdout.write(JSON.stringify(await moveOutOfTrash(...process.argv.slice(-2))));`;
    const outcomes = await Promise.all(
      photos.map(async (photo) => {
        const child = Bun.spawn(
          [process.execPath, '--no-install', '-e', script, photo.primary, target],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exit !== 0) throw new Error(`restore subprocess failed: ${stderr}`);
        return JSON.parse(stdout) as Awaited<ReturnType<typeof moveOutOfTrash>>;
      }),
    );
    const destinations = new Set<string>();
    for (const [id, outcome] of outcomes.entries()) {
      if (outcome.kind !== 'ok') throw new Error(outcome.error);
      expect(destinations.has(outcome.newAbsPath)).toBe(false);
      destinations.add(outcome.newAbsPath);
      expect(await fs.readFile(outcome.newAbsPath, 'utf8')).toBe(photos[id].pixels);
      const sidecar = sidecarRenameTarget(
        photos[id].primary,
        outcome.newAbsPath,
        photos[id].sidecar,
      )!;
      expect(await fs.readFile(sidecar, 'utf8')).toBe(photos[id].edits);
      expect(await fs.exists(photos[id].primary)).toBe(false);
      expect(await fs.exists(photos[id].sidecar)).toBe(false);
    }
    expect(destinations.size).toBe(photos.length);
    await expectNoTemporaryFiles();
  });

  for (const edited of [true, false]) {
    test(`an orphan XMP is preserved when restoring a ${edited ? 'edited' : 'unedited'} photo`, async () => {
      const photo = await stage(1, edited);
      const target = path.join(root, 'photo.dng');
      const orphan = path.join(root, 'photo.xmp');
      await fs.writeFile(orphan, '<xmp>unrelated existing edits</xmp>');
      const result = await moveOutOfTrash(photo.primary, target);
      expect(result).toEqual({
        kind: 'ok',
        newAbsPath: path.join(root, 'photo.restored.dng'),
      });
      expect(await fs.readFile(orphan, 'utf8')).toBe('<xmp>unrelated existing edits</xmp>');
      expect(await fs.exists(target)).toBe(false);
      expect(await fs.readFile(path.join(root, 'photo.restored.dng'), 'utf8')).toBe(photo.pixels);
      const restoredSidecar = path.join(root, 'photo.restored.xmp');
      if (edited) expect(await fs.readFile(restoredSidecar, 'utf8')).toBe(photo.edits);
      else expect(await fs.exists(restoredSidecar)).toBe(false);
      await expectNoTemporaryFiles();
    });
  }

  test('orphan conflict sidecars occupy a candidate and source conflicts follow the chosen stem', async () => {
    const photo = await stage(2);
    const sourceConflict = path.join(path.dirname(photo.primary), 'photo (conflict from Mac).xmp');
    await fs.writeFile(sourceConflict, '<xmp>incoming conflict edits</xmp>');
    await fs.writeFile(path.join(root, 'photo.dng'), 'occupied primary');
    const orphan = path.join(root, 'photo.restored (conflict from Mac).xmp');
    await fs.writeFile(orphan, '<xmp>existing conflict edits</xmp>');
    const result = await moveOutOfTrash(photo.primary, path.join(root, 'photo.dng'));
    expect(result).toEqual({
      kind: 'ok',
      newAbsPath: path.join(root, 'photo.restored.1.dng'),
    });
    expect(await fs.readFile(orphan, 'utf8')).toBe('<xmp>existing conflict edits</xmp>');
    expect(await fs.readFile(path.join(root, 'photo.dng'), 'utf8')).toBe('occupied primary');
    expect(await fs.readFile(path.join(root, 'photo.restored.1.xmp'), 'utf8')).toBe(photo.edits);
    expect(
      await fs.readFile(path.join(root, 'photo.restored.1 (conflict from Mac).xmp'), 'utf8'),
    ).toBe('<xmp>incoming conflict edits</xmp>');
    expect(await fs.exists(sourceConflict)).toBe(false);
    await expectNoTemporaryFiles();
  });

  test('a failed sidecar copy retains the entire source and publishes no primary', async () => {
    const photo = await stage(3, false);
    await fs.mkdir(photo.sidecar);
    await fs.writeFile(path.join(photo.sidecar, 'existing.txt'), 'unrelated directory occupant');
    const target = path.join(root, 'photo.dng');
    const result = await moveOutOfTrash(photo.primary, target);
    expect(result.kind).toBe('error');
    expect(await fs.readFile(photo.primary, 'utf8')).toBe(photo.pixels);
    expect(await fs.readFile(path.join(photo.sidecar, 'existing.txt'), 'utf8')).toBe(
      'unrelated directory occupant',
    );
    expect(await fs.exists(target)).toBe(false);
    expect(await fs.exists(path.join(root, 'photo.xmp'))).toBe(false);
    await expectNoTemporaryFiles();
  });

  test('restoring to the source itself is rejected without renaming or deleting the pair', async () => {
    const photo = await stage(4);
    const result = await moveOutOfTrash(photo.primary, photo.primary);
    expect(result.kind).toBe('error');
    expect(await fs.readFile(photo.primary, 'utf8')).toBe(photo.pixels);
    expect(await fs.readFile(photo.sidecar, 'utf8')).toBe(photo.edits);
    await expectNoTemporaryFiles();
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable source directory is an error rather than an unedited photo',
    async () => {
      const photo = await stage(7);
      const dir = path.dirname(photo.primary);
      await fs.chmod(dir, 0o300);
      try {
        const result = await moveOutOfTrash(photo.primary, path.join(root, 'photo.dng'));
        expect(result.kind).toBe('error');
        expect(await fs.exists(path.join(root, 'photo.dng'))).toBe(false);
      } finally {
        await fs.chmod(dir, 0o700);
      }
      expect(await fs.readFile(photo.primary, 'utf8')).toBe(photo.pixels);
      expect(await fs.readFile(photo.sidecar, 'utf8')).toBe(photo.edits);
      await expectNoTemporaryFiles();
    },
  );

  test('a previously absent destination directory is created for the restored pair', async () => {
    const photo = await stage(5);
    const target = path.join(root, 'new', 'nested', 'photo.dng');
    expect(await moveOutOfTrash(photo.primary, target)).toEqual({
      kind: 'ok',
      newAbsPath: target,
    });
    expect(await fs.readFile(target, 'utf8')).toBe(photo.pixels);
    expect(await fs.readFile(path.join(root, 'new', 'nested', 'photo.xmp'), 'utf8')).toBe(
      photo.edits,
    );
    await expectNoTemporaryFiles();
  });

  test('same-stem photo and video sidecars retain their independent pairing', async () => {
    const photo = await stage(6);
    const video = path.join(path.dirname(photo.primary), 'photo.MOV');
    const videoSidecar = `${video}.xmp`;
    await fs.writeFile(video, 'original-video');
    await fs.writeFile(videoSidecar, '<xmp>video-only edits</xmp>');
    const target = path.join(root, 'photo.MOV');
    await fs.writeFile(target, 'existing-video');
    const result = await moveOutOfTrash(video, target);
    expect(result).toEqual({
      kind: 'ok',
      newAbsPath: path.join(root, 'photo.restored.MOV'),
    });
    expect(await fs.readFile(`${path.join(root, 'photo.restored.MOV')}.xmp`, 'utf8')).toBe(
      '<xmp>video-only edits</xmp>',
    );
    expect(await fs.readFile(target, 'utf8')).toBe('existing-video');
    expect(await fs.readFile(photo.primary, 'utf8')).toBe(photo.pixels);
    expect(await fs.readFile(photo.sidecar, 'utf8')).toBe(photo.edits);
    await expectNoTemporaryFiles();
  });

  test('verified restore publication and source deletion replicate to the configured mirror', async () => {
    const mirror = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-restore-mirror-'));
    setMirrorRoots({ [root]: [mirror] });
    try {
      const photo = await stage(8);
      fs.replicatePath(photo.primary);
      fs.replicatePath(photo.sidecar);
      await fs.flushPendingMirrorOps();
      const oldMirror = path.join(mirror, path.relative(root, photo.primary));
      const oldMirrorSidecar = path.join(mirror, path.relative(root, photo.sidecar));
      expect(await fs.readFile(oldMirror, 'utf8')).toBe(photo.pixels);
      expect(await fs.readFile(oldMirrorSidecar, 'utf8')).toBe(photo.edits);
      const target = path.join(root, 'photo.dng');
      expect(await moveOutOfTrash(photo.primary, target)).toEqual({
        kind: 'ok',
        newAbsPath: target,
      });
      await fs.flushPendingMirrorOps();
      expect(await fs.readFile(path.join(mirror, 'photo.dng'), 'utf8')).toBe(photo.pixels);
      expect(await fs.readFile(path.join(mirror, 'photo.xmp'), 'utf8')).toBe(photo.edits);
      expect(await fs.exists(oldMirror)).toBe(false);
      expect(await fs.exists(oldMirrorSidecar)).toBe(false);
      expect(
        (await fs.readdir(mirror, { recursive: true })).some((name) => name.includes('.tmp.')),
      ).toBe(false);
    } finally {
      await fs.flushPendingMirrorOps();
      clearMirrorRoots();
      await fs.rm(mirror, { recursive: true, force: true });
    }
  });
});
