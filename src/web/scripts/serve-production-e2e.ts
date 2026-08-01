import { join, resolve } from 'node:path';
import { access, mkdir, readFile } from 'node:fs/promises';
import {
  cleanupProductionFixtures,
  stageProductionFixtures,
  verifyOriginalRawHashes,
  verifyStagedRawHashes,
  type ProductionFixtureManifest,
} from '../e2e/support/production-fixtures';
import { prepareHostedUpdateFixtures } from './production-update-fixtures';

const WEB_ROOT = resolve(import.meta.dirname, '..');
const API_ROOT = resolve(WEB_ROOT, '../api');
const HOSTED_PORT = process.env.MAPLE_E2E_HOSTED_PORT ?? '4400';
const SELF_HOSTED_PORT = process.env.MAPLE_E2E_SELF_HOSTED_PORT ?? '4401';
const children: Bun.Subprocess[] = [];
let manifest: ProductionFixtureManifest | undefined;
let shutdown: Promise<never> | null = null;

async function requireRawFfi(): Promise<void> {
  const filename = process.platform === 'darwin' ? 'libraw_ffi.dylib' : 'libraw_ffi.so';
  const path = resolve(API_ROOT, 'native', filename);
  try {
    await access(path);
  } catch {
    throw new Error(
      `Production Chrome tests require ${path}. Build it with src/api/scripts/build-raw-ffi.sh.`,
    );
  }
}

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
    if (await endpointIsReady(url)) return;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForFile(path: string, child: Bun.Subprocess): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${path} producer exited before becoming ready`);
    const value = await readFile(path, 'utf8').catch(() => '');
    if (value) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function endpointIsReady(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function verifyAndCleanupFixtures(value: ProductionFixtureManifest): Promise<boolean> {
  let valid = true;
  try {
    await verifyOriginalRawHashes(value);
    await verifyStagedRawHashes(value);
  } catch (error) {
    console.error('Production Chrome tests failed RAW immutability verification', error);
    valid = false;
  }
  try {
    await cleanupProductionFixtures(value);
  } catch (error) {
    console.error('Production Chrome fixture cleanup failed', error);
    valid = false;
  }
  return valid;
}

function killActiveChildren(signal: NodeJS.Signals): void {
  children.filter((child) => child.exitCode === null).forEach((child) => child.kill(signal));
}

async function terminateChildren(): Promise<void> {
  killActiveChildren('SIGTERM');
  const exited = Promise.allSettled(children.map((child) => child.exited));
  const timedOut = await Promise.race([exited.then(() => false), Bun.sleep(5000).then(() => true)]);
  if (timedOut) {
    killActiveChildren('SIGKILL');
    await exited;
  }
}

async function finalExitCode(exitCode: number): Promise<number> {
  if (!manifest) return exitCode;
  return (await verifyAndCleanupFixtures(manifest)) ? exitCode : 1;
}

async function performStop(exitCode: number): Promise<never> {
  await terminateChildren();
  process.exit(await finalExitCode(exitCode));
}

function stop(exitCode: number): Promise<never> {
  shutdown ??= performStop(exitCode);
  return shutdown;
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

try {
  await requireRawFfi();
  manifest = await stageProductionFixtures();
  // Build the shared WASM once, then build both Angular surfaces directly.
  // The package prebuild hooks each rebuild WASM; running both would duplicate
  // the release gate's most expensive compile and introduce an avoidable race.
  await run(['bun', 'run', 'raw-wasm'], { FORCE_WASM_REBUILD: '1' });
  await run(['bun', 'x', 'ng', 'build', 'maple-syrup', '--configuration', 'production']);
  await run(['bun', 'run', 'check:hosted-artifact']);
  const hostedUpdate = await prepareHostedUpdateFixtures();
  await run(['bun', 'x', 'ng', 'build', 'maple', '--configuration', 'production']);

  const mongoUriFile = join(manifest.root, 'runtime', 'mongo-uri');
  await mkdir(join(manifest.root, 'runtime'), { recursive: true });
  const mongo = Bun.spawn(['bun', 'run', 'test:production-mongo'], {
    cwd: API_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, MAPLE_E2E_MONGO_URI_FILE: mongoUriFile },
  });
  children.push(mongo);
  const mongoUri = await waitForFile(mongoUriFile, mongo);

  const api = Bun.spawn(['bun', 'src/index.ts'], {
    cwd: API_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      PORT: SELF_HOSTED_PORT,
      MAPLE_DEV: '0',
      MAPLE_DEV_AUTH: '1',
      MAPLE_ROOTS: manifest.root,
      MAPLE_UI_DIST: resolve(WEB_ROOT, 'dist/maple/browser'),
      MAPLE_MONGO_URI: mongoUri,
      MAPLE_MONGO_DB: 'maple_e2e',
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
      DIST: hostedUpdate.v1,
      MAPLE_E2E_UPDATE_DIST: hostedUpdate.v2,
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
  await stop(1);
}
