import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
  type LiveTestDatabase,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots, loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { panoStitchHandler } from './pano-stitch.ts';
import * as mirrored from '../../fs/mirrored.ts';
import { clearMirrorRoots, setMirrorRoots } from '../../fs/mirror-registry.ts';
import { replaceFolderDestinations } from '../../cloud-backup/local-mirror-bridge.ts';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let live: LiveTestDatabase;
let tmpDir = '';
let fakeCli = '';
let argsLog = '';
let spawnedPathLog = '';
let folderId = '';
let assetIds: string[] = [];

beforeAll(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-pano-engine-test-')));
  fakeCli = path.join(tmpDir, 'fake-maple-cli');
  argsLog = path.join(tmpDir, 'args.txt');
  spawnedPathLog = path.join(tmpDir, 'spawned-path.txt');
  await fs.writeFile(
    fakeCli,
    `#!/bin/sh
printf '%s\\n' "$0" > "${spawnedPathLog}"
printf '%s\\n' "$@" > "${argsLog}"
printf '%s\\n' "MAPLE_PANO_MODELS=$MAPLE_PANO_MODELS" "ORT_DYLIB_PATH=$ORT_DYLIB_PATH" >> "${argsLog}"
LINEAR=""; DISPLAY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) shift; LINEAR="$1";;
    --display) shift; DISPLAY="$1";;
  esac
  shift
done
[ -n "$LINEAR" ] && echo 'scene-linear carrier' > "$LINEAR"
[ -n "$DISPLAY" ] && echo '${TINY_PNG_B64}' | base64 -d > "$DISPLAY"
exit 0
`,
  );
  await fs.chmod(fakeCli, 0o755);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  live = await createLiveTestDatabase();
  const libPath = path.join(tmpDir, 'lib');
  await fs.mkdir(libPath, { recursive: true });
  folderId = insertFolder(live.db, { path: libPath, slug: 'pano-engine-lib' });
  invalidateLibraryRoots();
  const png = Buffer.from(TINY_PNG_B64, 'base64');
  assetIds = await Promise.all(
    ['in-a.png', 'in-b.png'].map(async (filename) => {
      await fs.writeFile(path.join(libPath, filename), png);
      const assetId = insertAsset(live.db);
      run(live.db, `UPDATE assets SET maple_id = ? WHERE id = ?`, `seed-${filename}`, assetId);
      insertLocation(live.db, { assetId, libraryId: folderId, path: '', filename });
      return assetId;
    }),
  );
});

afterEach(() => {
  live.close();
  invalidateLibraryRoots();
});

const handlerContext = () => ({
  jobId: new ObjectId(),
  reportProgress: async () => {},
  shouldCancel: async () => false,
});

const basePayload = () => ({
  assetIds,
  libraryId: folderId,
  outputDir: path.join(tmpDir, `out-${new ObjectId().toHexString()}`),
  retention: 'keep',
  localAlign: 'mesh',
  strategy: null,
  strategySupported: false,
  mapleCli: fakeCli,
  modelsDir: null,
  ortDylibPath: null,
});

async function stitchArgs(extra: Record<string, unknown>): Promise<string[]> {
  const outcome = await panoStitchHandler.run({ ...basePayload(), ...extra }, handlerContext());
  expect(outcome.kind).toBe('done');
  return (await fs.readFile(argsLog, 'utf8')).split('\n');
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

describe('panoStitchHandler feature engine (#4555)', () => {
  it('runs the classical matcher without model paths', async () => {
    const args = await stitchArgs({ featuresEngine: 'classical' });
    expect(flagValue(args, '--features-engine')).toBe('classical');
    expect(args).not.toContain('--models-dir');
  });

  it('omits --features-engine for a binary that predates it and still hands it the ML paths', async () => {
    const ortDylib = path.join(tmpDir, 'libonnxruntime.so');
    const args = await stitchArgs({
      featuresEngine: null,
      modelsDir: tmpDir,
      ortDylibPath: ortDylib,
    });
    expect(args).not.toContain('--features-engine');
    expect(flagValue(args, '--models-dir')).toBe(tmpDir);
    expect(args).toContain(`ORT_DYLIB_PATH=${ortDylib}`);
  });

  it('records the matcher it ran and why it fell back in the result (#5487)', async () => {
    const note = 'Used the classical matcher because the models are missing.';
    const outcome = await panoStitchHandler.run(
      { ...basePayload(), featuresEngine: 'classical', matcherNote: note },
      handlerContext(),
    );
    expect(outcome.kind).toBe('done');
    expect(outcome.result).toMatchObject({ matcher: 'classical', matcherNote: note });
  });

  it('does not hand ML model paths to a classical run', async () => {
    const args = await stitchArgs({
      featuresEngine: 'classical',
      modelsDir: tmpDir,
      ortDylibPath: path.join(tmpDir, 'libonnxruntime.so'),
    });
    expect(args).not.toContain('--models-dir');
    expect(args).not.toContain(`MAPLE_PANO_MODELS=${tmpDir}`);
  });

  it('runs the ML matcher with its models directory and ONNX Runtime', async () => {
    const ortDylib = path.join(tmpDir, 'libonnxruntime.so');
    const args = await stitchArgs({
      featuresEngine: 'ml',
      modelsDir: tmpDir,
      ortDylibPath: ortDylib,
    });
    expect(flagValue(args, '--features-engine')).toBe('ml');
    expect(flagValue(args, '--models-dir')).toBe(tmpDir);
    expect(args).toContain(`MAPLE_PANO_MODELS=${tmpDir}`);
    expect(args).toContain(`ORT_DYLIB_PATH=${ortDylib}`);
  });

  // #4743 — a persisted payload is re-checked against the current library
  // roots right before the spawn, so a legacy or re-rooted executable inside
  // a member-writable library never runs.
  it('refuses to spawn a persisted mapleCli that sits inside a library root', async () => {
    const planted = path.join(tmpDir, 'lib', 'planted-cli');
    await fs.copyFile(fakeCli, planted);
    await fs.rm(argsLog, { force: true });
    await expect(
      panoStitchHandler.run({ ...basePayload(), mapleCli: planted }, handlerContext()),
    ).rejects.toThrow('library root');
    await expect(fs.stat(argsLog)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to spawn with a persisted ortDylibPath inside a library root', async () => {
    const planted = path.join(tmpDir, 'lib', 'libonnxruntime.dylib');
    await fs.writeFile(planted, 'not a dylib');
    await fs.rm(argsLog, { force: true });
    await expect(
      panoStitchHandler.run(
        { ...basePayload(), featuresEngine: 'ml', modelsDir: tmpDir, ortDylibPath: planted },
        handlerContext(),
      ),
    ).rejects.toThrow('library root');
    await expect(fs.stat(argsLog)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('spawns the canonical binary, not the pathname the payload named', async () => {
    const aliasDir = path.join(tmpDir, 'alias-outside');
    await fs.symlink(tmpDir, aliasDir);
    try {
      const args = await stitchArgs({ mapleCli: path.join(aliasDir, 'fake-maple-cli') });
      expect(args.length).toBeGreaterThan(0);
      const spawned = await fs.readFile(spawnedPathLog, 'utf8');
      expect(spawned.trim()).toBe(await fs.realpath(fakeCli));
    } finally {
      await fs.unlink(aliasDir);
    }
  });

  it('sees a library registered after its root cache warmed, before spawning', async () => {
    const lateLib = path.join(tmpDir, 'late-lib');
    await fs.mkdir(lateLib, { recursive: true });
    const planted = path.join(lateLib, 'late-cli');
    await fs.copyFile(fakeCli, planted);
    // Warm this process's root cache with the original library only, as a
    // long-lived worker would have, then register the new library elsewhere.
    await loadLibraryRoots();
    insertFolder(live.db, { path: lateLib, slug: 'pano-late-lib' });
    await fs.rm(argsLog, { force: true });
    await expect(
      panoStitchHandler.run({ ...basePayload(), mapleCli: planted }, handlerContext()),
    ).rejects.toThrow('library root');
    await expect(fs.stat(argsLog)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sees a mirror configured after the job was queued, before spawning', async () => {
    const mirror = path.join(tmpDir, 'late-mirror');
    await fs.mkdir(mirror, { recursive: true });
    const planted = path.join(mirror, 'late-mirror-cli');
    await fs.copyFile(fakeCli, planted);
    await replaceFolderDestinations(folderId, [{ path: mirror, enabled: true }]);
    await fs.rm(argsLog, { force: true });
    await expect(
      panoStitchHandler.run({ ...basePayload(), mapleCli: planted }, handlerContext()),
    ).rejects.toThrow('mirror');
    await expect(fs.stat(argsLog)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses an ML run whose ONNX Runtime path is missing', async () => {
    await expect(
      panoStitchHandler.run(
        { ...basePayload(), featuresEngine: 'ml', modelsDir: tmpDir },
        handlerContext(),
      ),
    ).rejects.toThrow('ML matcher');
  });
});

describe('panoStitchHandler output location (#5488)', () => {
  const libPath = () => path.join(tmpDir, 'lib');

  it('imports the result into Panoramas/ beside the first source frame', async () => {
    const outcome = await panoStitchHandler.run(basePayload(), handlerContext());
    expect(outcome.kind).toBe('done');
    const result = outcome.result as { outputAssetId: string; outputPath: string };
    expect(path.dirname(result.outputPath)).toBe(path.join(libPath(), 'Panoramas'));
    expect(path.basename(result.outputPath)).toMatch(/^in-a-pano-[0-9a-f]{8}\.png$/);
    expect(await fs.readFile(result.outputPath)).toEqual(Buffer.from(TINY_PNG_B64, 'base64'));
    const [location] = live.db
      .query(`SELECT path, filename FROM asset_locations WHERE asset_id = ?`)
      .all(result.outputAssetId) as { path: string; filename: string }[];
    expect(location).toEqual({ path: 'Panoramas', filename: path.basename(result.outputPath) });
  });

  it('returns the panorama an earlier run made for the same frames without stitching again', async () => {
    const first = await panoStitchHandler.run(basePayload(), handlerContext());
    await fs.rm(spawnedPathLog, { force: true });
    const again = await panoStitchHandler.run(basePayload(), handlerContext());
    expect(again.kind).toBe('done');
    expect(again.result).toMatchObject({
      outputAssetId: (first.result as { outputAssetId: string }).outputAssetId,
      outputPath: (first.result as { outputPath: string }).outputPath,
    });
    expect(await fs.stat(spawnedPathLog).catch(() => null)).toBeNull();
  });

  it('imports the display-encoded PNG and never asks for the scene-linear one', async () => {
    const outcome = await panoStitchHandler.run(basePayload(), handlerContext());
    const args = (await fs.readFile(argsLog, 'utf8')).split('\n');
    expect(args).not.toContain('--out');
    expect(flagValue(args, '--display')).toBeDefined();
    const { outputPath } = outcome.result as { outputPath: string };
    expect(await fs.readFile(outputPath)).toEqual(Buffer.from(TINY_PNG_B64, 'base64'));
  });

  it('gives different options a panorama of their own', async () => {
    const keep = await panoStitchHandler.run(basePayload(), handlerContext());
    const strict = await panoStitchHandler.run(
      { ...basePayload(), retention: 'strict' },
      handlerContext(),
    );
    expect((strict.result as { outputPath: string }).outputPath).not.toBe(
      (keep.result as { outputPath: string }).outputPath,
    );
  });

  describe('on a mirrored library', () => {
    const mirrorPath = () => path.join(tmpDir, 'mirror');

    beforeEach(async () => {
      await fs.rm(mirrorPath(), { recursive: true, force: true });
      setMirrorRoots({ [libPath()]: [mirrorPath()] });
    });
    afterEach(() => clearMirrorRoots());

    const mirroredEntries = async () => {
      await mirrored.flushPendingMirrorOps();
      return fs.readdir(path.join(mirrorPath(), 'Panoramas')).catch(() => []);
    };

    it('replicates the panorama a hard link puts in place', async () => {
      const outcome = await panoStitchHandler.run(basePayload(), handlerContext());
      const { outputPath } = outcome.result as { outputPath: string };
      expect(await mirroredEntries()).toEqual([path.basename(outputPath)]);
    });

    it('replicates the panorama on a volume that cannot hard-link, never its temp file', async () => {
      const crossMount = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      const link = spyOn(mirrored, 'link').mockRejectedValueOnce(crossMount);
      try {
        const outcome = await panoStitchHandler.run(basePayload(), handlerContext());
        const { outputPath } = outcome.result as { outputPath: string };
        expect(link).toHaveBeenCalledTimes(1);
        expect(await fs.readFile(outputPath)).toEqual(Buffer.from(TINY_PNG_B64, 'base64'));
        expect(await mirroredEntries()).toEqual([path.basename(outputPath)]);
        const beside = await fs.readdir(path.dirname(outputPath));
        expect(beside.filter((name) => name.includes('.tmp.'))).toEqual([]);
      } finally {
        link.mockRestore();
      }
    });

    it('replicates through a library registered by a symlinked path', async () => {
      const alias = path.join(tmpDir, 'lib-alias');
      await fs.rm(alias, { force: true });
      await fs.symlink(libPath(), alias);
      run(live.db, `UPDATE folders SET path = ? WHERE id = ?`, alias, folderId);
      invalidateLibraryRoots();
      setMirrorRoots({ [alias]: [mirrorPath()] });
      try {
        const outcome = await panoStitchHandler.run(basePayload(), handlerContext());
        const { outputPath } = outcome.result as { outputPath: string };
        expect(path.dirname(outputPath)).toBe(path.join(alias, 'Panoramas'));
        expect(await mirroredEntries()).toEqual([path.basename(outputPath)]);
      } finally {
        await fs.unlink(alias);
      }
    });
  });
});

describe('panoStitchHandler containment', () => {
  const libPath = () => path.join(tmpDir, 'lib');
  const outside = () => path.join(tmpDir, 'outside');

  beforeEach(async () => {
    await fs.rm(path.join(libPath(), 'Panoramas'), { recursive: true, force: true });
    await fs.rm(outside(), { recursive: true, force: true });
    await fs.mkdir(outside(), { recursive: true });
  });

  it('refuses a Panoramas folder that is a symlink out of the library', async () => {
    await fs.symlink(outside(), path.join(libPath(), 'Panoramas'));
    await expect(panoStitchHandler.run(basePayload(), handlerContext())).rejects.toThrow(
      'outside the library',
    );
    expect(await fs.readdir(outside())).toEqual([]);
  });

  it('never imports or writes through a symlink planted at the panorama name', async () => {
    const first = await panoStitchHandler.run(basePayload(), handlerContext());
    const { outputPath } = first.result as { outputPath: string };
    await fs.rm(outputPath);
    const secret = path.join(outside(), 'secret.png');
    await fs.writeFile(secret, 'not yours');
    await fs.symlink(secret, outputPath);
    await expect(panoStitchHandler.run(basePayload(), handlerContext())).rejects.toThrow(
      'non-file',
    );
    expect(await fs.readFile(secret, 'utf8')).toBe('not yours');
  });

  it('refuses an input whose library file links outside every library', async () => {
    const frame = path.join(libPath(), 'in-a.png');
    const original = await fs.readFile(frame);
    await fs.writeFile(path.join(outside(), 'elsewhere.png'), original);
    await fs.rm(frame);
    await fs.symlink(path.join(outside(), 'elsewhere.png'), frame);
    try {
      await expect(panoStitchHandler.run(basePayload(), handlerContext())).rejects.toThrow(
        'outside every library root',
      );
    } finally {
      await fs.rm(frame);
      await fs.writeFile(frame, original);
    }
  });

  it('refuses ML models that live inside a library', async () => {
    const models = path.join(libPath(), 'models');
    await fs.mkdir(models, { recursive: true });
    await expect(
      panoStitchHandler.run(
        {
          ...basePayload(),
          featuresEngine: 'ml',
          modelsDir: models,
          ortDylibPath: path.join(tmpDir, 'libonnxruntime.so'),
        },
        handlerContext(),
      ),
    ).rejects.toThrow('models_dir must not point inside a library root');
  });

  it('leaves nothing at the panorama name when the copy dies part-way', async () => {
    const copy = spyOn(mirrored, 'copyFile').mockImplementationOnce(async (_src, dest) => {
      await fs.writeFile(String(dest), 'trunc');
      throw new Error('disk vanished');
    });
    try {
      await expect(panoStitchHandler.run(basePayload(), handlerContext())).rejects.toThrow(
        'disk vanished',
      );
    } finally {
      copy.mockRestore();
    }
    expect(await fs.readdir(path.join(libPath(), 'Panoramas'))).toEqual([]);
    const retry = await panoStitchHandler.run(basePayload(), handlerContext());
    const { outputPath } = retry.result as { outputPath: string };
    expect(await fs.readFile(outputPath)).toEqual(Buffer.from(TINY_PNG_B64, 'base64'));
  });

  it('announces a panorama once, not again when a retry finds it made', async () => {
    const first = await panoStitchHandler.run(basePayload(), handlerContext());
    await panoStitchHandler.run(basePayload(), handlerContext());
    const { outputAssetId } = first.result as { outputAssetId: string };
    const changes = live.db
      .query(`SELECT kind FROM asset_changes WHERE asset_id = ?`)
      .all(outputAssetId);
    expect(changes).toEqual([{ kind: 'create' }]);
  });

  it('announces the imported panorama on the change feed', async () => {
    const outcome = await panoStitchHandler.run(basePayload(), handlerContext());
    const { outputAssetId, outputPath } = outcome.result as {
      outputAssetId: string;
      outputPath: string;
    };
    const change = live.db
      .query(`SELECT kind, relative_path FROM asset_changes WHERE asset_id = ?`)
      .get(outputAssetId);
    expect(change).toEqual({
      kind: 'create',
      relative_path: `Panoramas/${path.basename(outputPath)}`,
    });
  });
});
