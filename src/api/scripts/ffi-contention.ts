#!/usr/bin/env bun
/** Finite opt-in local qualification for #3527 / #3721. Never part of CI.
 * bun scripts/ffi-contention.ts --run RAW_PATH JPEG_PATH NEW_REPORT_PATH */
// Raw fs allowlist (#3721): read-only fixtures; writes are isolated temporary outputs and a local report.
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _createFfiPoolForTests } from '../src/ffi/ffi-pool.ts';
import { defaultChildWorkerFactory } from '../src/ffi/ffi-child-worker.ts';
import { nativeLibPath } from '../src/ffi/raw_ffi.ts';
import { findNativeLib } from '../../maple/src/native.ts';
import { ContentionObserver, parseRssSnapshot, type RssSample } from './ffi-contention-observer.ts';

const API_ROOT = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(API_ROOT, '../..');
const RUN_TIMEOUT_MS = 120_000;
const SAMPLE_MS = 100;
const ORDERS = [
  [1, 2, 4],
  [2, 4, 1],
  [4, 1, 2],
] as const;

export function parseArguments(args: string[]) {
  if (args.length !== 4 || args[0] !== '--run') {
    throw new Error(
      'Usage: bun scripts/ffi-contention.ts --run RAW_PATH JPEG_PATH NEW_REPORT_PATH',
    );
  }
  const [raw, jpeg, output] = args.slice(1).map((path) => resolve(path));
  if (output === raw || output === jpeg) throw new Error('report must not overwrite a fixture');
  return { raw, jpeg, output };
}

async function fileIdentity(path: string) {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error(`not a regular file: ${canonical}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(canonical)) hash.update(chunk);
  return { path: canonical, bytes: info.size, sha256: hash.digest('hex') };
}

function commandText(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function rss(elapsedMs: number): RssSample {
  return parseRssSnapshot(
    commandText(['ps', '-axo', 'pid=,ppid=,rss=,command=']),
    process.pid,
    elapsedMs,
  );
}

async function waitForChildren(): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (rss(0).children.length > 0) {
    if (performance.now() >= deadline) throw new Error('FFI children did not exit after shutdown');
    await Bun.sleep(50);
  }
}

function checkOk(result: { ok: boolean; error?: string; reason?: string } | boolean): void {
  if (result === true || (typeof result === 'object' && result.ok)) return;
  throw new Error(
    typeof result === 'object'
      ? (result.error ?? result.reason ?? 'native operation failed')
      : 'native operation failed',
  );
}

async function runTrial(raw: string, jpeg: string, directory: string, workers: number) {
  const started = performance.now();
  const observer = new ContentionObserver(() => performance.now() - started);
  // Explicit availability uses the real check: the test seam's default bypass
  // is unsuitable for native qualification.
  const pool = _createFfiPoolForTests({
    workerFactory: observer.factory(defaultChildWorkerFactory),
    availableOverride: await Bun.file(nativeLibPath()).exists(),
  });
  pool.setPoolSize(workers);
  const samples: RssSample[] = [rss(0)];
  const samplerErrors: string[] = [];
  const sampler = setInterval(() => {
    try {
      samples.push(rss(performance.now() - started));
    } catch (error) {
      samplerErrors.push(String(error));
    }
  }, SAMPLE_MS);
  const rawOut = join(directory, 'raw.jpg');
  const rawJob = observer.measure('raw-develop', rawOut, async () => {
    checkOk(await pool.renderDevelopJpegToFile(raw, null, rawOut, 1280));
  });
  // Four bitmap renders are submitted behind one full RAW develop. Each
  // successful bitmap queues validation only after its own AVIF exists.
  const bitmapJobs = Array.from({ length: 4 }, (_, index) =>
    (async () => {
      const output = join(directory, `bitmap-${index}.avif`);
      await observer.measure(`bitmap-${index}`, output, async () => {
        checkOk(await pool.renderBitmapThumbToFile(jpeg, output, 512, 55, 'jpg', 'avif'));
      });
      await observer.measure(`validate-${index}`, output, async () => {
        checkOk(await pool.validateAvif(output, 512));
      });
    })(),
  );
  const jobs = Promise.allSettled([rawJob, ...bitmapJobs]);
  const interrupted = () => {
    samplerErrors.push('interrupted');
    pool.shutdown();
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      jobs,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('trial timed out'));
        }, RUN_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    samplerErrors.push(String(error));
  } finally {
    clearTimeout(timer);
    clearInterval(sampler);
    try {
      samples.push(rss(performance.now() - started));
    } catch (error) {
      samplerErrors.push(String(error));
    }
    pool.shutdown();
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
  const settled = await jobs;
  await waitForChildren();
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [String(result.reason)] : [],
  );
  const requests = observer.report();
  const ok =
    !timedOut &&
    failures.length === 0 &&
    samplerErrors.length === 0 &&
    requests.length === 9 &&
    samples.some((sample) => sample.children.length > 0);
  return {
    workers,
    ok,
    timedOut,
    failures,
    samplerErrors,
    requests,
    samples,
    sampledMaxParentRssBytes: Math.max(...samples.map((sample) => sample.parentRssBytes)),
    sampledMaxChildrenRssBytes: Math.max(...samples.map((sample) => sample.childRssBytes)),
    sampledMaxCombinedRssBytes: Math.max(
      ...samples.map((sample) => sample.parentRssBytes + sample.childRssBytes),
    ),
  };
}

async function preflight(options: ReturnType<typeof parseArguments>) {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('RSS sampling requires macOS or Linux ps');
  const [raw, jpeg, apiNative] = await Promise.all([
    fileIdentity(options.raw),
    fileIdentity(options.jpeg),
    fileIdentity(nativeLibPath()),
  ]);
  const header = new Uint8Array(await Bun.file(jpeg.path).slice(0, 2).arrayBuffer());
  if (header[0] !== 0xff || header[1] !== 0xd8)
    throw new Error('JPEG fixture must have a JPEG signature');
  const maplePath = findNativeLib();
  if (!maplePath) throw new Error('Maple package native library is missing');
  const mapleNative = await fileIdentity(maplePath);
  if (mapleNative.sha256 !== apiNative.sha256)
    throw new Error(
      'API and Maple native library hashes differ; rebuild/sync before qualification',
    );
  const packageEntry = fileURLToPath(import.meta.resolve('maple'));
  const packageIdentity = await fileIdentity(packageEntry);
  return { raw, jpeg, apiNative, mapleNative, packageIdentity };
}

async function main(args: string[]) {
  const options = parseArguments(args);
  const { raw, jpeg, apiNative, mapleNative, packageIdentity } = await preflight(options);
  // Exclusive creation prevents replacing fixtures or existing reports, even
  // through symlinks. A preflight/incomplete report is never success evidence.
  const report = {
    schemaVersion: 1,
    issue: 3527,
    harnessIssue: 3721,
    status: 'incomplete',
    recordedAt: new Date().toISOString(),
    gitSha: commandText(['git', 'rev-parse', 'HEAD']),
    gitStatus: commandText(['git', 'status', '--porcelain']),
    host: {
      platform: process.platform,
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      bun: Bun.version,
    },
    fixtures: { raw, jpeg },
    native: { apiNative, mapleNative },
    packageEntry: packageIdentity,
    measurement: {
      runTimeoutMs: RUN_TIMEOUT_MS,
      sampleIntervalMs: SAMPLE_MS,
      orders: ORDERS,
      timing:
        'parent submission-to-post includes spawn; post-to-reply includes startup/IPC/native processing',
      rss: 'sampled RSS, not true peak/private memory; summed child RSS can double-count shared pages',
      workload:
        'fresh pool per trial; one 1280px RAW develop followed by four 512px JPEG-to-AVIF renders, each followed by AVIF validation; OS file caches not flushed',
    },
    trials: [] as Awaited<ReturnType<typeof runTrial>>[],
    error: null as string | null,
  };
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  const directory = await mkdtemp(join(tmpdir(), 'maple-ffi-contention-'));
  try {
    for (const order of ORDERS)
      for (const workers of order) {
        const runDirectory = await mkdtemp(join(directory, `workers-${workers}-`));
        const trial = await runTrial(raw.path, jpeg.path, runDirectory, workers);
        report.trials.push(trial);
        await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
        if (!trial.ok) throw new Error(`worker count ${workers}: incomplete or failed trial`);
      }
    const [rawAfter, jpegAfter] = await Promise.all([
      fileIdentity(raw.path),
      fileIdentity(jpeg.path),
    ]);
    if (rawAfter.sha256 !== raw.sha256 || jpegAfter.sha256 !== jpeg.sha256)
      throw new Error('fixture changed during run');
    report.status = 'completed';
  } catch (error) {
    report.status = 'failed';
    report.error = String(error);
    throw error;
  } finally {
    try {
      await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
