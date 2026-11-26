#!/usr/bin/env bun
/** Two-process benchmark for #6020: on-demand preview latency while a worker process renders a RAW thumbnail backlog, gated vs not. Not a production number.
 * bun scripts/render-priority-bench.ts FIXTURE_DIR OUT_DIR [--trials N] [--window-s S] */
import { readdir, rm, mkdir } from '../src/fs/mirrored.ts';
import { loadavg, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { generateThumb, isRawThumbSource } from '../src/indexer/thumbnailer.ts';
import { ffiPool } from '../src/ffi/ffi-pool.ts';
import { ondemandPreviews } from '../src/indexer/ondemand-preview.ts';
import {
  isPreviewPriorityReadyMessage,
  isPreviewStageRenderMessage,
} from '../src/indexer/preview-priority-protocol.ts';
import { installWorkerPreviewPriority } from '../src/workers/background-render-gate.ts';
import { runBackgroundRender } from '../src/workers/background-render-gate.ts';

const STAGE_CONCURRENCY = 2;
const PREVIEW_EVERY_MS = 3_000;
const WARMUP_MS = 5_000;
const SETTLE_MS = 1_500;

function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const [fixtureDir, outDir] = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--') && isNaN(Number(a)))
  .map((a) => resolve(a));

async function fixtures(): Promise<string[]> {
  const names = (await readdir(fixtureDir!)).filter((n) => isRawThumbSource(n)).sort();
  if (names.length === 0) throw new Error(`no RAW fixtures in ${fixtureDir}`);
  return names.map((n) => join(fixtureDir!, n));
}

async function runWorker(): Promise<void> {
  installWorkerPreviewPriority();
  const sources = await fixtures();
  let gated = false;
  let completed = 0;
  process.on('message', (message: { type?: string; gated?: boolean }) => {
    if (message.type === 'bench-mode') gated = message.gated === true;
    if (message.type === 'bench-report') process.send?.({ type: 'bench-count', completed });
  });
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      const source = sources[at % sources.length]!;
      const out = join(outDir!, 'worker', `${at % (STAGE_CONCURRENCY * 4)}.avif`);
      await rm(out, { force: true });
      const render = () => generateThumb(source, out);
      await (gated ? runBackgroundRender(render) : render());
      completed++;
    }
  };
  await Promise.all(Array.from({ length: STAGE_CONCURRENCY }, lane));
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

async function runApi(): Promise<void> {
  const trials = option('--trials', 15);
  const windowMs = option('--window-s', 15) * 1_000;
  const sources = await fixtures();
  await mkdir(join(outDir!, 'worker'), { recursive: true });
  await mkdir(join(outDir!, 'api'), { recursive: true });

  let counted: ((completed: number) => void) | null = null;
  const worker = Bun.spawn([process.execPath, import.meta.path, fixtureDir!, outDir!, '--worker'], {
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(message) {
      if (isPreviewPriorityReadyMessage(message)) {
        ondemandPreviews().attachWorker((m) => worker.send(m));
      } else if (isPreviewStageRenderMessage(message)) {
        ondemandPreviews().onStageRender(message);
      } else {
        counted?.((message as unknown as { completed: number }).completed);
      }
    },
  });
  const completedNow = (): Promise<number> =>
    new Promise((resolveCount) => {
      counted = resolveCount;
      worker.send({ type: 'bench-report' });
    });

  const samples = { baseline: [] as number[], gated: [] as number[] };
  const thumbs = { baseline: 0, gated: 0 };
  const seconds = { baseline: 0, gated: 0 };
  const load0 = loadavg();

  await Bun.sleep(WARMUP_MS);
  for (let trial = 0; trial < trials * 2; trial++) {
    const mode = trial % 2 === 0 ? 'baseline' : 'gated';
    worker.send({ type: 'bench-mode', gated: mode === 'gated' });
    const startCount = await completedNow();
    const started = performance.now();
    await Bun.sleep(SETTLE_MS);
    while (performance.now() - started < windowMs) {
      const previewPath = join(outDir!, 'api', 'preview.avif');
      await rm(previewPath, { force: true });
      const t0 = performance.now();
      await ondemandPreviews().render(sources[0]!, previewPath);
      samples[mode].push(performance.now() - t0);
      await Bun.sleep(PREVIEW_EVERY_MS);
    }
    thumbs[mode] += (await completedNow()) - startCount;
    seconds[mode] += (performance.now() - started) / 1_000;
  }
  worker.kill();

  const summary = (mode: 'baseline' | 'gated') => {
    const sorted = [...samples[mode]].sort((a, b) => a - b);
    return {
      mode,
      previews: sorted.length,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
      backlogThumbsPerMin: Math.round((thumbs[mode] / seconds[mode]) * 60),
    };
  };
  console.log(
    JSON.stringify({
      trialsPerMode: trials,
      windowSeconds: windowMs / 1_000,
      rawLaneWidth: ffiPool().poolSize(),
      stageConcurrency: STAGE_CONCURRENCY,
      cpuCores: cpus().length,
      loadAverageBefore: load0.map((n) => Number(n.toFixed(2))),
      loadAverageAfter: loadavg().map((n) => Number(n.toFixed(2))),
      results: [summary('baseline'), summary('gated')],
    }),
  );
  process.exit(0);
}

await (process.argv.includes('--worker') ? runWorker() : runApi());
