/** Actual production-worker scope and reply gate (#3397).
 * bun scripts/verify-live-scopes.ts /readonly/100mp.dng [dist/browser] [srgb|display-p3]
 * No fixture skip or software GPU override. Scope hold is an instrumented native
 * mapAsync Promise, never a replacement renderer. Canvas readback is used ONLY
 * as a pixel oracle outside measured edits. Reply timing is not scanout timing.
 */
import { chromium } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { hashFixture } from './lib/hash-fixture';
import { defaultAdjustmentModel } from '../projects/maple-common/src/lib/models/adjustment-model';
import { buildLiveParams } from '../projects/maple-common/src/lib/components/image-canvas/image-canvas.live-params';

const fixture = process.argv[2];
if (!fixture) throw new Error('An explicit read-only RAW fixture is required.');
const dist = resolve(process.argv[3] ?? 'dist/maple-syrup/browser');
const colorSpace = process.argv[4] ?? 'srgb';
assert.ok(['srgb', 'display-p3'].includes(colorSpace));
const workerFile = readdirSync(dist).find(
  (file) =>
    /^worker-.*\.js$/.test(file) &&
    readFileSync(resolve(dist, file), 'utf8').includes('"export-success"'),
);
assert.ok(workerFile, 'Production RAW worker must exist');
const params = Array.from(buildLiveParams({ ...defaultAdjustmentModel(), profile: 'Neutral' }));
const originalHash = await hashFixture(fixture);
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const wrapper = `
const counts = {};
for (const key of ['createBuffer','createTexture','createBindGroup','createComputePipeline','createComputePipelineAsync','createRenderPipeline','createRenderPipelineAsync']) {
  counts[key] = 0;
  const original = GPUDevice.prototype[key];
  if (typeof original === 'function') GPUDevice.prototype[key] = function(...args) {
    counts[key]++; return Reflect.apply(original, this, args);
  };
}
let hold = true, held = [], canvas, captureOracle = false, oracle;
function captureCanvas() {
  const target = new OffscreenCanvas(canvas.width, canvas.height);
  const context = target.getContext('2d', {colorSpace:'srgb', willReadFrequently:true});
  context.drawImage(canvas, 0, 0);
  const source = context.getImageData(0,0,canvas.width,canvas.height).data;
  const scale=Math.min(1,512/Math.max(canvas.width,canvas.height));
  const width=Math.round(canvas.width*scale),height=Math.round(canvas.height*scale);
  const rgb=new Uint8Array(width*height*3);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const sx=Math.min(canvas.width-1,Math.floor((x+.5)*canvas.width/width));
    const sy=Math.min(canvas.height-1,Math.floor((y+.5)*canvas.height/height));
    const from=(sy*canvas.width+sx)*4, to=(y*width+x)*3;
    rgb.set(source.subarray(from,from+3),to);
  }
  return rgb;
}
const post = self.postMessage.bind(self);
self.postMessage = function(message, transfer) {
  // Freeze the actual frame before Chromium discards the worker backing store
  // on compositor commit. Enabled only for an untimed correctness frame.
  if(captureOracle && message.type==='render-session-success') oracle={renderId:message.id,rgb:captureCanvas()};
  post(message,transfer ?? []);
};
const map = GPUBuffer.prototype.mapAsync;
GPUBuffer.prototype.mapAsync = function(...args) {
  const pending = Reflect.apply(map, this, args);
  return this.label === 'scope-sample-staging' && hold
    ? pending.then(() => new Promise(resolve => held.push(resolve))) : pending;
};
const marks = [];
new PerformanceObserver(list => marks.push(...list.getEntries().map(e => ({name:e.name,duration:e.duration})))).observe({entryTypes:['measure']});
addEventListener('message', ({data}) => {
  if (data.type === 'open-session') canvas = data.canvas;
  if (data.type === 'probe-stats') postMessage({id:data.id, type:'probe-stats-result', counts:{...counts}, held:held.length, marks:marks.splice(0)});
  if (data.type === 'probe-hold') { hold=true; postMessage({id:data.id,type:'probe-held'}); }
  if (data.type === 'probe-release') {
    hold = false; for (const release of held.splice(0)) release();
    postMessage({id:data.id, type:'probe-released'});
  }
  if(data.type==='probe-oracle') {
    captureOracle=data.enabled; post({id:data.id,type:'probe-oracle-set'});
  }
  if (data.type === 'probe-canvas') {
    if(!oracle) throw new Error('No captured presented frame');
    const rgb=oracle.rgb.slice();
    post({id:data.id,type:'probe-canvas-result',renderId:oracle.renderId,rgb:rgb.buffer},[rgb.buffer]);
  }
});
await import('/${workerFile}'); postMessage({id:0,type:'probe-ready'});
`;
const routes: Record<string, () => Response> = {
  '/': () =>
    new Response('<!doctype html><canvas></canvas>', {
      headers: { ...headers, 'Content-Type': 'text/html' },
    }),
  '/probe.js': () =>
    new Response(wrapper, { headers: { ...headers, 'Content-Type': 'text/javascript' } }),
  '/fixture': () => new Response(Bun.file(fixture), { headers }),
};
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (routes[path]) return routes[path]();
    const file = resolve(dist, `.${path}`);
    return file.startsWith(dist + sep)
      ? new Response(Bun.file(file), { headers })
      : new Response(null, { status: 403 });
  },
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url.href);
  const result = await page.evaluate(
    async ({ colorSpace, params }) => {
      function check(condition: unknown, message: string): asserts condition {
        if (!condition) throw new Error(message);
      }
      const adapter = await navigator.gpu?.requestAdapter();
      check(adapter, 'Real WebGPU adapter required');
      const adapterInfo = {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      };
      const worker = new Worker('/probe.js', { type: 'module' });
      let id = 0;
      const pending = new Map<
        number,
        {
          resolve: (value: any) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      const scopes = new Map<number, any>();
      const logs: any[] = [];
      let ready!: () => void;
      const initialized = new Promise<void>((resolve) => {
        ready = resolve;
      });
      worker.onmessage = ({ data }) => {
        if (data.type === 'probe-ready') {
          ready();
          return;
        }
        if (data.type === 'session-scope') {
          scopes.set(data.renderId, { ...data, arrived: performance.now() });
          return;
        }
        settleRequest(data);
      };
      function settleRequest(data: any) {
        const request = pending.get(data.id);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(data.id);
          request.resolve(data);
        } else if (data.type === 'worker-log') logs.push(data);
      }

      worker.onerror = (error) => {
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(error.message));
        }
        pending.clear();
      };
      const send = (body: any, transfer: Transferable[] = []): Promise<any> =>
        new Promise((resolve, reject) => {
          const requestId = ++id;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`Timed out: ${body.type}`));
          }, 180_000);
          pending.set(requestId, { resolve, reject, timer });
          worker.postMessage({ ...body, id: requestId }, transfer);
        });
      const waitFor = async (predicate: () => boolean, reason: string) => {
        const start = performance.now();
        while (!predicate()) {
          if (performance.now() - start > 10_000) throw new Error(reason);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      const xmp = (exposure: number) =>
        `<rdf:Description xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:papp="https://justmaple.app/ns/xmp/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" papp:Profile="Neutral" crs:Exposure2012="${exposure}"/>`;
      const edit = async (exposure: number, flat = false) => {
        const values = new Float32Array(params);
        values[0] = exposure;
        const start = performance.now();
        const reply = await send({
          type: 'render-session',
          xmp: xmp(exposure),
          ...(flat ? { params: values } : {}),
        });
        if (reply.type !== 'render-session-success') throw new Error(JSON.stringify(reply));
        return { id: reply.id, start, ms: performance.now() - start };
      };
      const sample = async (requestId: number) => {
        await waitFor(() => scopes.has(requestId), `No final scope for render ${requestId}`);
        return scopes.get(requestId);
      };
      const stats = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          n: values.length,
          median: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
          max: sorted.at(-1),
        };
      };
      const compare = (a: ArrayBuffer, b: ArrayBuffer) => {
        const left = new Uint8Array(a),
          right = new Uint8Array(b);
        if (left.length !== right.length) throw new Error('Pixel oracle dimensions disagree');
        let max = 0,
          changed = 0;
        for (let i = 0; i < left.length; i++) {
          const error = Math.abs(left[i] - right[i]);
          max = Math.max(max, error);
          changed += error > 0 ? 1 : 0;
        }
        return { max, changed, channels: left.length };
      };
      try {
        await Promise.race([
          initialized,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Worker import timeout')), 30_000),
          ),
        ]);
        const bytes = await (await fetch('/fixture')).arrayBuffer();
        const canvas = document.querySelector('canvas')!.transferControlToOffscreen();
        const start = performance.now();
        const opened = await send(
          {
            type: 'open-session',
            bytes,
            ext: 'dng',
            canvas,
            xmp: xmp(0),
            maxLongEdge: 2048,
            targetColorSpace: colorSpace,
          },
          [bytes, canvas],
        );
        check(opened.type === 'open-session-success', JSON.stringify(opened));
        const openMs = performance.now() - start;
        const waitForHeldMap = async () => {
          let probe = await send({ type: 'probe-stats' });
          const waitStart = performance.now();
          while (probe.held === 0) {
            if (performance.now() - waitStart > 10_000)
              throw new Error('No actual scope staging map intercepted');
            await new Promise((resolve) => setTimeout(resolve, 5));
            probe = await send({ type: 'probe-stats' });
          }
        };
        await waitForHeldMap();
        // The actual first scope map is held. Two real edits MUST still finish.
        const heldEdit1 = await edit(0.25);
        await send({ type: 'probe-oracle', enabled: true });
        const heldEdit2 = await edit(0.75);
        await send({ type: 'probe-oracle', enabled: false });
        check(scopes.size === 0, 'Held scope map unexpectedly published');
        const dimensions = {
          width: Math.round(
            opened.width * Math.min(1, 512 / Math.max(opened.width, opened.height)),
          ),
          height: Math.round(
            opened.height * Math.min(1, 512 / Math.max(opened.width, opened.height)),
          ),
        };
        const heldCanvas = await send({ type: 'probe-canvas', ...dimensions });
        await send({ type: 'probe-release' });
        const trailing = await sample(heldEdit2.id);
        check(trailing.sessionId === opened.id, 'Scope session identity failed');
        check(!scopes.has(heldEdit1.id), 'Scope coalescing failed');
        check(heldCanvas.renderId === heldEdit2.id, 'Pixel oracle captured another edit');
        const canvasParity = compare(trailing.scope.rgb, heldCanvas.rgb);
        check(
          canvasParity.max <= 2,
          `Scope does not match presented sRGB pixels: ${JSON.stringify(canvasParity)}`,
        );
        const discrete = await edit(-0.5);
        const discreteScope = await sample(discrete.id);
        const changedPixels = compare(trailing.scope.rgb, discreteScope.scope.rgb);
        check(changedPixels.changed > 0, 'Exposure did not change real pixels');
        const pace = async (enabled: boolean, elapsed: number) => {
          if (enabled)
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 / 60 - elapsed)));
        };
        const allocationDelta = (before: any, after: any) => {
          check(before.createBuffer > 0, 'GPU buffer probe was not exercised');
          check(before.createBindGroup > 0, 'GPU bind-group probe was not exercised');
          const delta = Object.fromEntries(
            Object.keys(after).map((key) => [key, after[key] - before[key]]),
          );
          check(
            Object.values(delta).every((count) => count === 0),
            `Per-drag GPU allocation: ${JSON.stringify(delta)}`,
          );
          return delta;
        };
        const requireScopeRefresh = (paced: boolean, count: number) => {
          if (paced) check(count > 0, 'Scopes starved throughout a 60Hz drag');
        };
        const runDrag = async (paced: boolean) => {
          await edit(0); // establish full-XMP prefix before scalar params
          let warmup;
          for (let i = 0; i < 3; i++) warmup = await edit(i * 0.1, true);
          await sample(warmup!.id); // drain warmup GPU work before timing
          const before = await send({ type: 'probe-stats' });
          const replies = [];
          for (let i = 0; i < 30; i++) {
            const tick = await edit(-0.5 + (i % 15) / 10, true);
            replies.push(tick);
            await pace(paced, tick.ms);
          }
          const final = replies.at(-1)!;
          const finalScope = await sample(final.id);
          const after = await send({ type: 'probe-stats' });
          const allocations = allocationDelta(before.counts, after.counts);
          const scopeUpdatesDuringDrag = [...scopes.values()].filter(
            (update) => update.renderId >= replies[0].id && update.arrived < final.start + final.ms,
          ).length;
          requireScopeRefresh(paced, scopeUpdatesDuringDrag);
          return {
            scopeUpdatesDuringDrag,
            reply: stats(replies.map((value) => value.ms)),
            render: stats(
              after.marks
                .filter((mark: any) => mark.name === 'maple:session-render')
                .map((mark: any) => mark.duration),
            ),
            scopeMap: stats(
              after.marks
                .filter((mark: any) => mark.name === 'maple:scope-readback')
                .map((mark: any) => mark.duration),
            ),
            finalScopeLatencyMs: finalScope.arrived - final.start,
            initialGpuResources: before.counts,
            allocations,
          };
        };
        const burst = await runDrag(false);
        const paced = await runDrag(true);
        // Free the real WASM session with an owned map still pending, then open
        // a fresh image. Completion must free the old result without publishing it.
        await send({ type: 'probe-hold' });
        const abandoned = await edit(0.2);
        await waitForHeldMap();
        worker.postMessage({ id: ++id, type: 'close-session' });
        const replacementCanvas = document.createElement('canvas').transferControlToOffscreen();
        const replacementBytes = await (await fetch('/fixture')).arrayBuffer();
        const replacement = await send(
          {
            type: 'open-session',
            bytes: replacementBytes,
            ext: 'dng',
            canvas: replacementCanvas,
            xmp: xmp(0),
            maxLongEdge: 2048,
            targetColorSpace: colorSpace,
          },
          [replacementBytes, replacementCanvas],
        );
        check(replacement.type === 'open-session-success', JSON.stringify(replacement));
        await send({ type: 'probe-release' });
        const replacementScope = await sample(replacement.id);
        check(
          replacementScope.sessionId === replacement.id,
          'Replacement scope has old session identity',
        );
        check(!scopes.has(abandoned.id), 'Closed session published its late sample');
        return {
          adapterInfo,
          requestedColorSpace: colorSpace,
          achievedColorSpace: opened.colorSpace,
          nativeDimensions: [opened.nativeWidth, opened.nativeHeight],
          previewDimensions: [opened.width, opened.height],
          scopeDimensions: [discreteScope.scope.width, discreteScope.scope.height],
          openMs,
          pendingMapReopenPassed: true,
          heldMap: {
            ordinaryEditReplyMs: heldEdit1.ms,
            // Includes intentionally blocking canvas oracle; excluded from performance gate.
            untimedOracleEditReplyMs: heldEdit2.ms,
          },
          canvasParity,
          changedPixels,
          burst,
          paced,
          logs,
        };
      } finally {
        worker.terminate();
      }
    },
    { colorSpace, params },
  );
  assert.equal(await hashFixture(fixture), originalHash, 'Original RAW must remain unchanged');
  assert.deepEqual(errors, [], 'Browser must not raise an unhandled error');
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        browserVersion: browser.version(),
        fixtureSha256: originalHash,
        workerFile,
        workerSha256: createHash('sha256')
          .update(readFileSync(resolve(dist, workerFile)))
          .digest('hex'),
        ...result,
      },
      null,
      2,
    ),
  );
  assert.ok(
    result.paced.reply.p95 <= 50,
    `50ms reply gate failed: P95 ${result.paced.reply.p95}ms`,
  );
} finally {
  await browser.close();
  await server.stop();
}
