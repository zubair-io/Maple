import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
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
OUT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--out" ]; then
    shift; OUT="$1"
  fi
  shift
done
echo '${TINY_PNG_B64}' | base64 -d > "$OUT"
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

  it('refuses an ML run whose ONNX Runtime path is missing', async () => {
    await expect(
      panoStitchHandler.run(
        { ...basePayload(), featuresEngine: 'ml', modelsDir: tmpDir },
        handlerContext(),
      ),
    ).rejects.toThrow('ML matcher');
  });
});
