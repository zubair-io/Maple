import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const REQUIRED_RAW_FIXTURES = [
  'test_0004.fff',
  'test_0006.DNG',
  'test_0008.RAF',
  'test_0016.X3F',
  'test_0017.dng',
] as const;

export const PRODUCTION_FIXTURE_MANIFEST = resolve(
  process.env.MAPLE_E2E_FIXTURE_MANIFEST ??
    join(
      tmpdir(),
      `maple-production-e2e-fixtures-${process.env.MAPLE_E2E_HOSTED_PORT ?? '4400'}-${process.env.MAPLE_E2E_SELF_HOSTED_PORT ?? '4401'}.json`,
    ),
);

export interface FixtureHash {
  readonly path: string;
  readonly sha256: string;
}

export interface ProductionFixtureManifest {
  readonly root: string;
  readonly freshFolder: string;
  readonly populatedFolder: string;
  readonly sourceHashes: readonly FixtureHash[];
  readonly stagedRawHashes: readonly FixtureHash[];
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function hashFiles(paths: readonly string[]): Promise<FixtureHash[]> {
  return Promise.all(paths.map(async (path) => ({ path, sha256: await sha256(path) })));
}

export async function stageProductionFixtures(
  sourceDir = resolve(__dirname, '../../../../test-fixtures/raws'),
): Promise<ProductionFixtureManifest> {
  const sourcePaths = REQUIRED_RAW_FIXTURES.map((name) => join(sourceDir, name));
  const missing: string[] = [];
  for (const path of sourcePaths) {
    try {
      await access(path);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Production Chrome tests require the RAW fixtures below; release projects never soft-skip:\n${missing.join('\n')}`,
    );
  }

  const root = await mkdtemp(join(tmpdir(), 'maple-production-e2e-'));
  const freshFolder = join(root, 'fresh');
  const populatedFolder = join(root, 'populated');
  await Promise.all([
    mkdir(freshFolder, { recursive: true }),
    mkdir(join(populatedFolder, '.maple', 'thumbs'), { recursive: true }),
    mkdir(join(populatedFolder, '.maple', 'previews'), { recursive: true }),
  ]);

  const stagedRawPaths = await Promise.all(
    sourcePaths.slice(0, 4).map(async (sourcePath) => {
      const destination = join(freshFolder, basename(sourcePath));
      await copyFile(sourcePath, destination);
      return destination;
    }),
  );

  const populatedRaw = join(populatedFolder, 'test_0017.dng');
  await copyFile(sourcePaths[4], populatedRaw);
  stagedRawPaths.push(populatedRaw);

  const baselineXmp = resolve(
    __dirname,
    '../../../../test-fixtures/references/test_0017/xmp/baseline.xmp',
  );
  try {
    await copyFile(baselineXmp, join(populatedFolder, 'test_0017.xmp'));
  } catch {
    await cleanupProductionFixtures({ root } as ProductionFixtureManifest);
    throw new Error(`Production Chrome tests require the populated XMP fixture: ${baselineXmp}`);
  }

  const manifest: ProductionFixtureManifest = {
    root,
    freshFolder,
    populatedFolder,
    sourceHashes: await hashFiles(sourcePaths),
    stagedRawHashes: await hashFiles(stagedRawPaths),
  };
  await mkdir(dirname(PRODUCTION_FIXTURE_MANIFEST), { recursive: true });
  await writeFile(PRODUCTION_FIXTURE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readProductionFixtureManifest(): Promise<ProductionFixtureManifest> {
  return JSON.parse(
    await readFile(PRODUCTION_FIXTURE_MANIFEST, 'utf8'),
  ) as ProductionFixtureManifest;
}

export async function verifyOriginalRawHashes(manifest: ProductionFixtureManifest): Promise<void> {
  await verifyHashes(manifest.sourceHashes, 'source');
}

export async function verifyStagedRawHashes(manifest: ProductionFixtureManifest): Promise<void> {
  await verifyHashes(manifest.stagedRawHashes, 'staged');
}

async function verifyHashes(expected: readonly FixtureHash[], label: string): Promise<void> {
  const current = await hashFiles(expected.map(({ path }) => path));
  const changed = current.filter(
    ({ path, sha256: digest }) =>
      expected.find(({ path: original }) => original === path)?.sha256 !== digest,
  );
  if (changed.length > 0) {
    throw new Error(
      `Production Chrome tests modified ${label} RAWs:\n${changed.map(({ path }) => path).join('\n')}`,
    );
  }
}

export async function cleanupProductionFixtures(
  manifest: Pick<ProductionFixtureManifest, 'root'>,
): Promise<void> {
  await rm(manifest.root, { recursive: true, force: true });
  await rm(PRODUCTION_FIXTURE_MANIFEST, { force: true });
}
