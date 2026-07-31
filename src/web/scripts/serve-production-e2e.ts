import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  cleanupProductionFixtures,
  stageProductionFixtures,
  verifyOriginalRawHashes,
  type ProductionFixtureManifest,
} from '../e2e/support/production-fixtures';

const WEB_ROOT = resolve(import.meta.dirname, '..');
const API_ROOT = resolve(WEB_ROOT, '../api');
const HOSTED_PORT = process.env.MAPLE_E2E_HOSTED_PORT ?? '4400';
const SELF_HOSTED_PORT = process.env.MAPLE_E2E_SELF_HOSTED_PORT ?? '4401';
const children: Bun.Subprocess[] = [];
let manifest: ProductionFixtureManifest | undefined;
let stopping = false;

async function run(command: string[], env: Record<string, string | undefined> = {}): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: WEB_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...globalThis.process.env, ...env },
  });
  if ((await process.exited) !== 0) throw new Error(`${command.join(' ')} failed`);
}

async function waitFor(url: string, child: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${url} server exited before becoming ready`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Server is still starting.
    }
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(exitCode: number): Promise<never> {
  if (stopping) process.exit(exitCode);
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  if (manifest) {
    try {
      await verifyOriginalRawHashes(manifest);
    } finally {
      await cleanupProductionFixtures(manifest);
    }
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

try {
  manifest = await stageProductionFixtures();
  // Build the shared WASM once, then build both Angular surfaces directly.
  // The package prebuild hooks each rebuild WASM; running both would duplicate
  // the release gate's most expensive compile and introduce an avoidable race.
  await run(['bun', 'run', 'raw-wasm'], { FORCE_WASM_REBUILD: '1' });
  await run(['bun', 'x', 'ng', 'build', 'maple-syrup', '--configuration', 'production']);
  await run(['bun', 'x', 'ng', 'build', 'maple', '--configuration', 'production']);

  const api = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: API_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      PORT: SELF_HOSTED_PORT,
      MAPLE_DEV: '0',
      MAPLE_DEV_AUTH: '0',
      MAPLE_ROOTS: manifest.root,
      MAPLE_UI_DIST: resolve(WEB_ROOT, 'dist/maple/browser'),
      MAPLE_MONGO_URI:
        'mongodb://127.0.0.1:1/maple_e2e?serverSelectionTimeoutMS=250&connectTimeoutMS=250',
      MAPLE_INDEXER_AUTOSTART: '0',
      MAPLE_JWT_SECRET_FILE: resolve(manifest.root, 'runtime/jwt.secret'),
      MAPLE_BACKUP_TMP: resolve(manifest.root, 'runtime/backup'),
    },
  });
  children.push(api);
  await waitFor(`http://127.0.0.1:${SELF_HOSTED_PORT}/api/health`, api);

  const hosted = Bun.spawn(['bun', 'scripts/serve-dist-coep.mjs'], {
    cwd: WEB_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      DIST: resolve(WEB_ROOT, 'dist/maple-syrup/browser'),
      PORT: HOSTED_PORT,
    },
  });
  children.push(hosted);
  await waitFor(`http://127.0.0.1:${HOSTED_PORT}`, hosted);

  console.log(
    `production Chrome surfaces ready: hosted=${HOSTED_PORT} self-hosted=${SELF_HOSTED_PORT}`,
  );
  await Promise.race(children.map((child) => child.exited));
  await stop(1);
} catch (error) {
  console.error(error);
  if (manifest) await rm(manifest.root, { recursive: true, force: true });
  await stop(1);
}
