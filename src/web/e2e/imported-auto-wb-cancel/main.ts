import '@angular/compiler';
import { createApplication } from '@angular/platform-browser';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { GPU_LIVE_RENDER_ENABLED } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.token';

// #5923: the production RawPipelineService and render worker in a real Chrome,
// cross-origin isolated or not. A slider render issued while the imported Auto
// WB estimate runs on the worker is timed against the uninterrupted estimate.
const xmp = (exposure: number) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:WhiteBalance="Auto" crs:Exposure2012="${exposure}"/></rdf:RDF></x:xmpmeta>`;
const LONG_EDGE = 1024;

const resolvePosts = (): PerformanceEntry[] =>
  performance
    .getEntriesByType('mark')
    .filter((m) => m.name.startsWith('maple:resolve-imported-wb:') && m.name.endsWith(':start'));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function nextResolvePost(seen: number): Promise<number> {
  for (;;) {
    const posts = resolvePosts();
    if (posts.length > seen) return posts[seen].startTime;
    await sleep(1);
  }
}

async function open(pipeline: RawPipelineService, bytes: Uint8Array): Promise<void> {
  pipeline.closeLiveSession();
  const element = document.createElement('canvas');
  element.width = LONG_EDGE;
  element.height = LONG_EDGE;
  await pipeline.openLiveSession(
    element.transferControlToOffscreen(),
    bytes,
    'dng',
    xmp(0),
    LONG_EDGE,
  );
}

async function tick(pipeline: RawPipelineService, exposure: number): Promise<number> {
  const started = performance.now();
  await pipeline.renderLiveSession(xmp(exposure));
  return performance.now() - started;
}

export async function run(rawUrl: string, delaysMs: number[]) {
  if (!navigator.gpu) throw new Error('This measurement needs a WebGPU adapter.');
  const bytes = new Uint8Array(await (await fetch(rawUrl)).arrayBuffer());
  const app = await createApplication({
    providers: [{ provide: GPU_LIVE_RENDER_ENABLED, useValue: true }],
  });
  try {
    const pipeline = app.injector.get(RawPipelineService);
    await open(pipeline, bytes);
    await tick(pipeline, 0.1);
    const idleTicks = [];
    for (let i = 0; i < 5; i++) idleTicks.push(await tick(pipeline, 0.2 + i / 10));

    const posted = resolvePosts().length;
    const reference = pipeline.resolveImportedWhiteBalance(bytes);
    const referencePosted = await nextResolvePost(posted);
    const pair = await reference;
    const estimateMs = performance.now() - referencePosted;

    const trials = [];
    for (const delay of delaysMs) {
      await open(pipeline, bytes);
      await sleep(500);
      const seen = resolvePosts().length;
      const asked = pipeline.resolveImportedWhiteBalance(bytes);
      const postedAt = await nextResolvePost(seen);
      await sleep(Math.max(0, delay - (performance.now() - postedAt)));
      const issuedAfterMs = performance.now() - postedAt;
      const tickMs = await tick(pipeline, 0.7);
      const retried = await asked;
      const settledAfterMs = performance.now() - postedAt;
      trials.push({
        issuedAfterMs,
        tickMs,
        waitedWithoutCancelMs: Math.max(0, estimateMs - issuedAfterMs),
        attempts: resolvePosts().length - seen,
        settledAfterMs,
        samePair: retried.temperature === pair.temperature && retried.tint === pair.tint,
      });
    }
    pipeline.closeLiveSession();
    return { isolated: crossOriginIsolated, estimateMs, idleTicks, pair, trials };
  } finally {
    app.destroy();
  }
}

Object.assign(window, { importedWbCancel: { ready: true, run } });
export type ImportedWbCancelHarness = { ready: boolean; run: typeof run };
