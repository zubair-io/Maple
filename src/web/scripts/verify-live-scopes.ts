/** Actual production-worker scope and reply gate (#3397).
 * bun scripts/verify-live-scopes.ts /readonly/100mp.dng [dist/browser] [srgb|display-p3]
 * No fixture skip or software GPU override. Scope hold delays JS delivery AFTER
 * the native map completes, never the GPU itself. Canvas readback is used ONLY
 * as a pixel oracle outside measured edits. Reply timing is not scanout timing.
 */
import { chromium } from '@playwright/test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { hashFixture } from './lib/hash-fixture';
import { scopeWorkerProbe } from './lib/live-scope-probe';

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
const artifactHash = (file: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(dist, file)))
    .digest('hex');
const workerSha256 = artifactHash(workerFile);
const wasmSha256 = artifactHash('raw_wasm_bg.wasm');

const originalHash = await hashFixture(fixture);
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
const wrapper = scopeWorkerProbe(workerFile);
const schedulerSource = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  readFileSync(
    'projects/maple-common/src/lib/components/image-canvas/image-canvas.two-phase.ts',
    'utf8',
  ),
);
const routes: Record<string, () => Response> = {
  '/': () =>
    new Response('<!doctype html><canvas></canvas>', {
      headers: { ...headers, 'Content-Type': 'text/html' },
    }),
  '/probe.js': () =>
    new Response(wrapper, { headers: { ...headers, 'Content-Type': 'text/javascript' } }),
  '/scheduler.js': () =>
    new Response(schedulerSource, { headers: { ...headers, 'Content-Type': 'text/javascript' } }),
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
    async ({ colorSpace }) => {
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
      const edit = async (exposure: number) => {
        const start = performance.now();
        const reply = await send({
          type: 'render-session',
          xmp: xmp(exposure),
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
        const waitForFence = async () => {
          const start = performance.now();
          while ((await send({ type: 'probe-stats' })).fences.held === 0) {
            check(performance.now() - start < 10_000, 'No actual GPU completion fence intercepted');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        };
        await send({ type: 'probe-fence', hold: true });
        const start = performance.now();
        let openSettled = false;
        const opening = send(
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
        ).then((value) => {
          openSettled = true;
          return value;
        });
        await waitForFence();
        check(!openSettled, 'Cold open acknowledged before GPU completion delivery');
        await send({ type: 'probe-fence' });
        const opened = await opening;
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
        // Native map completed; its JS result delivery is held. Rendering still
        // completes, but a held frame fence MUST bound admission to one frame.
        await send({ type: 'probe-fence', hold: true });
        let firstSettled = false,
          nextSettled = false;
        const first = edit(0.1).then((value) => {
          firstSettled = true;
          return value;
        });
        await waitForFence();
        const next = edit(0.15).then((value) => {
          nextSettled = true;
          return value;
        });
        const bounded = await send({ type: 'probe-stats' });
        check(!firstSettled && !nextSettled, 'Render acknowledged before GPU completion delivery');
        check(bounded.fences.active === 1, 'More than one GPU frame admitted');
        await send({ type: 'probe-fence' });
        await Promise.all([first, next]);
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
        await send({ type: 'probe-fence', reject: true });
        const rejected = await send({ type: 'render-session', xmp: xmp(0.3) });
        check(rejected.type === 'session-error', 'Failed completion fence acknowledged success');
        const recovered = await edit(0.4);
        await sample(recovered.id);
        check(!scopes.has(rejected.id), 'Failed render published a scope');
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
          await edit(0); // warm the same full-XMP path the Neutral editor uses
          let warmup;
          for (let i = 0; i < 3; i++) warmup = await edit(i * 0.1);
          await sample(warmup!.id); // drain warmup GPU work before timing
          const before = await send({ type: 'probe-stats' });
          const replies = [];
          for (let i = 0; i < 30; i++) {
            const tick = await edit(-0.5 + (i % 15) / 10);
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
            finalScopeAfterReplyMs: finalScope.arrived - final.start - final.ms,
            initialGpuResources: before.counts,
            allocations,
          };
        };
        const burst = await runDrag(false);
        const paced = await runDrag(true);
        // Drive the actual product scheduler at 60Hz independently of GPU speed.
        // A submitted frame must retain admission until completion, so obsolete
        // inputs coalesce rather than hiding seconds of GPU work behind fast acks.
        const schedulerUrl = '/scheduler.js';
        const { TwoPhaseRenderScheduler } = await import(schedulerUrl);
        const scheduledReplies: { id: number; xmp: string; completed: number }[] = [];
        let scheduledError: Error | undefined;
        const scheduler = new TwoPhaseRenderScheduler({
          currentGeneration: () => 1,
          fastTargetPx: () => 2048,
          refineTargetPx: () => null,
          gpuActive: () => true,
          runRender: async (snapshot: string) => {
            const reply = await send({ type: 'render-session', xmp: snapshot });
            if (reply.type !== 'render-session-success')
              scheduledError = new Error(JSON.stringify(reply));
            scheduledReplies.push({ id: reply.id, xmp: snapshot, completed: performance.now() });
          },
        });
        let lastInput = 0;
        const finalXmp = xmp(0.29);
        for (let i = 0; i < 30; i++) {
          lastInput = performance.now();
          scheduler.schedule(xmp(i / 100), 1);
          await new Promise((resolve) => setTimeout(resolve, 1000 / 60));
        }
        await waitFor(
          () => scheduledReplies.at(-1)?.xmp === finalXmp,
          'Latest scheduled edit did not complete',
        );
        scheduler.clear();
        if (scheduledError) throw scheduledError;
        const scheduledFinal = scheduledReplies.at(-1)!;
        const scheduledScope = await sample(scheduledFinal.id);
        const schedulerDrag = {
          inputCount: 30,
          completedFrames: scheduledReplies.length,
          finalReplyFromLastInputMs: scheduledFinal.completed - lastInput,
          finalScopeFromLastInputMs: scheduledScope.arrived - lastInput,
          finalScopeAfterReplyMs: scheduledScope.arrived - scheduledFinal.completed,
        };
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
        const finalProbe = await send({ type: 'probe-stats' });
        check(finalProbe.fences.maxActive === 1, 'GPU completion fences overlapped');
        const expectedErrors = logs.filter(
          (entry) =>
            entry.level === 'error' &&
            entry.text.includes('Injected completed-frame fence failure'),
        );
        check(expectedErrors.length === 1, 'Completion failure was not exercised exactly once');
        check(
          logs.every((entry) => entry.level !== 'error' || expectedErrors.includes(entry)),
          'Worker emitted an unexpected error',
        );
        return {
          adapterInfo,
          requestedColorSpace: colorSpace,
          achievedColorSpace: opened.colorSpace,
          nativeDimensions: [opened.nativeWidth, opened.nativeHeight],
          previewDimensions: [opened.width, opened.height],
          scopeDimensions: [discreteScope.scope.width, discreteScope.scope.height],
          openMs,
          pendingMapReopenPassed: true,
          boundedGpuAdmissionPassed: true,
          fenceRejectionRecoveryPassed: true,
          maximumFramesInFlight: finalProbe.fences.maxActive,
          heldMap: {
            ordinaryEditReplyMs: heldEdit1.ms,
            // Includes intentionally blocking canvas oracle; excluded from performance gate.
            untimedOracleEditReplyMs: heldEdit2.ms,
          },
          canvasParity,
          changedPixels,
          burst,
          paced,
          schedulerDrag,
          expectedFenceErrorCount: expectedErrors.length,
          logs: logs.filter((entry) => !expectedErrors.includes(entry)),
        };
      } finally {
        worker.terminate();
      }
    },
    { colorSpace },
  );
  assert.equal(await hashFixture(fixture), originalHash, 'Original RAW must remain unchanged');
  assert.equal(
    artifactHash(workerFile),
    workerSha256,
    'Worker artifact changed during measurement',
  );
  assert.equal(artifactHash('raw_wasm_bg.wasm'), wasmSha256, 'WASM changed during measurement');
  assert.deepEqual(errors, [], 'Browser must not raise an unhandled error');
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        browserVersion: browser.version(),
        fixtureSha256: originalHash,
        workerFile,
        workerSha256,
        wasmSha256,
        ...result,
      },
      null,
      2,
    ),
  );
  for (const trial of [result.burst, result.paced, result.schedulerDrag]) {
    assert.ok(
      trial.finalScopeAfterReplyMs <= 50,
      `Final scope exceeded 50ms after completed-frame reply: ${trial.finalScopeAfterReplyMs}ms`,
    );
  }
  assert.ok(
    result.paced.reply.max! <= 50,
    `50ms hard reply gate failed: max ${result.paced.reply.max}ms`,
  );
} finally {
  await browser.close();
  await server.stop();
}
