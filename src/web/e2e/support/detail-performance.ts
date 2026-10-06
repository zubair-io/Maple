// #4112/#4123: observe real editor dispatch/ack and 2D canvas publication.
// No mocked workers, shader replacements, readback, or per-input render awaits.
import { expect, type Locator, type Page } from '@playwright/test';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';

const DEFAULT_MODEL = defaultAdjustmentModel();

export async function installDetailPerformanceObserver(page: Page, canonicalBytes: number) {
  await page.addInitScript((expectedBytes) => {
    const state = {
      inputs: [] as any[],
      requests: [] as any[],
      replies: [] as any[],
      paints: [] as any[],
      ambiguous: 0,
      pointerId: 0,
      pointerStartX: 0,
      worker: null as string | null,
      phase: 'setup',
      sweepStart: 0,
      sweepEnd: 0,
      unconsumed: [] as string[],
    };
    (window as any).__detailPerf = state;
    let workerNumber = 0;
    const bitmaps = new WeakMap<object, string>();
    let pendingDecode: {
      key: string;
      width: number;
      height: number;
      rgb: Uint8Array;
    } | null = null;
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        const token = `${++workerNumber}:${String(args[0])}`;
        worker.addEventListener('message', ({ data }) => {
          if (!Number.isInteger(data?.id) || token !== state.worker) return;
          const key = `${token}:${data.id}`;
          const request = state.requests.find((r) => r.key === key);
          if (!request) return; // Unrelated status/scope/export replies are not tick acknowledgments.
          state.replies.push({
            key,
            worker: token,
            id: data.id,
            type: data.type,
            at: performance.now(),
            width: data.width,
            height: data.height,
            nativeWidth: data.nativeWidth,
            nativeHeight: data.nativeHeight,
            colorSpace: data.colorSpace,
            message: data.message,
          });
          if (data.type === 'decode-success') {
            if (
              request.type !== 'decode' ||
              pendingDecode ||
              !(data.rgb instanceof ArrayBuffer) ||
              data.rgb.byteLength !== data.width * data.height * 3
            ) {
              state.ambiguous++;
              return;
            }
            const decoded = {
              key,
              width: data.width,
              height: data.height,
              rgb: new Uint8Array(data.rgb),
            };
            pendingDecode = decoded;
            // Production resolve/await/imageDataToBitmap occurs in this message
            // turn's microtasks. Do not carry a stale decode into a later task.
            setTimeout(() => {
              if (pendingDecode === decoded) {
                state.unconsumed.push(key);
                pendingDecode = null;
              }
            }, 0);
          }
        });
        const post = worker.postMessage.bind(worker);
        worker.postMessage = ((data: any, ...rest: any[]) => {
          if (['render-session', 'decode', 'open-session'].includes(data?.type)) {
            if (
              ['decode', 'open-session'].includes(data.type) &&
              data.ext?.toLowerCase() === 'dng' &&
              data.bytes?.byteLength === expectedBytes
            ) {
              if (state.worker && state.worker !== token) state.ambiguous++;
              else state.worker = token;
            }
            if (token === state.worker)
              state.requests.push({
                key: `${token}:${data.id}`,
                worker: token,
                id: data.id,
                type: data.type,
                at: performance.now(),
                phase: state.phase,
                input: state.phase === 'sweep' ? state.inputs.length - 1 : -1,
                xmp: data.xmp ?? '',
                params: data.params ? Array.from(data.params) : null,
                maxLongEdge: data.maxLongEdge,
                qualityPreview: data.qualityPreview,
              });
          }
          return (post as any)(data, ...rest);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    const create = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((image: any, ...rest: any[]) => {
      let decoded = image instanceof ImageData ? pendingDecode : null;
      if (decoded) {
        pendingDecode = null;
        const pixelCount = decoded.width * decoded.height;
        // Bounded guards for accidental unrelated same-task ImageData. This is
        // not a full RGB hash; custody comes from the audited synchronous
        // response->resolve->imageDataToBitmap path, then exact bitmap identity.
        const pixels = [0, Math.floor(pixelCount / 3), Math.floor(pixelCount / 2), pixelCount - 1];
        const coherent =
          image.width === decoded.width &&
          image.height === decoded.height &&
          pixels.every(
            (i) =>
              [0, 1, 2].every((c) => image.data[4 * i + c] === decoded!.rgb[3 * i + c]) &&
              image.data[4 * i + 3] === 255,
          );
        if (!coherent) {
          state.ambiguous++;
          decoded = null;
        }
      }
      return (create as any)(image, ...rest).then((bitmap: ImageBitmap) => {
        if (decoded) bitmaps.set(bitmap, decoded.key);
        return bitmap;
      });
    }) as typeof window.createImageBitmap;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      image: any,
      ...rest: any[]
    ) {
      (draw as any).call(this, image, ...rest);
      const key = bitmaps.get(image);
      if (
        key !== undefined &&
        this.canvas instanceof HTMLCanvasElement &&
        this.canvas.closest('editor-image-canvas')
      )
        state.paints.push({
          key,
          at: performance.now(),
          width: this.canvas.width,
          height: this.canvas.height,
        });
    } as typeof draw;
    document.addEventListener(
      'pointerdown',
      (event) => {
        state.pointerId = event.pointerId;
        state.pointerStartX = event.clientX;
      },
      true,
    );
  }, canonicalBytes);
}

// Fence all actual requests (including debounce/refine), rather than sleeping
// a guessed number of seconds. This happens only BETWEEN sweeps, never per input.
export async function fenceDetailRequests(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const s = (window as any).__detailPerf;
          const requests = s.requests;
          if (!requests.length) return false;
          const terminalType = {
            decode: 'decode-success',
            'open-session': 'open-session-success',
            'render-session': 'render-session-success',
          } as Record<string, string>;
          const failures = s.replies.filter((p: any) => /error/.test(p.type));
          if (failures.length) throw new Error(JSON.stringify(failures));
          if (s.ambiguous) throw new Error('Ambiguous observer custody');
          const last = requests.at(-1);
          return (
            performance.now() - last.at > 300 &&
            requests.every(
              (r: any) =>
                s.replies.filter((p: any) => p.key === r.key && p.type === terminalType[r.type])
                  .length === 1,
            ) &&
            (last.type !== 'decode' || s.paints.some((p: any) => p.key === last.key))
          );
        }),
      { timeout: 120_000 },
    )
    .toBe(true);
}

export async function setDetailValue(page: Page, slider: Locator, value: number) {
  const box = await slider.boundingBox();
  if (!box) throw new Error('Missing real slider geometry');
  const geometry = await slider.evaluate((el) => ({
    value: Number(el.getAttribute('aria-valuenow')),
    lo: Number(el.getAttribute('aria-valuemin')),
    hi: Number(el.getAttribute('aria-valuemax')),
  }));
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    x + ((value - geometry.value) * box.width) / (geometry.hi - geometry.lo),
    box.y + box.height / 2,
  );
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', String(value));
  await fenceDetailRequests(page);
}

export async function sweepDetail(
  page: Page,
  slider: Locator,
  arm: string,
  maximum: number,
  route: 'gpu' | 'cpu',
) {
  await setDetailValue(page, slider, 0);
  const box = await slider.boundingBox();
  if (!box) throw new Error('Missing slider');
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down(); // Genuine browser pointer creates capture/drag state.
  await slider.evaluate(
    async (el, { arm, maximum }) => {
      const s = (window as any).__detailPerf;
      s.inputs = [];
      s.requests = [];
      s.replies = [];
      s.paints = [];
      s.ambiguous = 0;
      s.unconsumed = [];
      s.phase = 'sweep';
      const rect = el.getBoundingClientRect();
      const range =
        Number(el.getAttribute('aria-valuemax')) - Number(el.getAttribute('aria-valuemin'));
      const startX = s.pointerStartX;
      const started = performance.now();
      s.sweepStart = started;
      for (let i = 1; i <= 60; i++) {
        const deadline = started + ((i - 1) * 1000) / 60;
        const wait = deadline - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const value = Math.round((maximum * i) / 60); // Authored integer slider step.
        s.inputs.push({
          arm,
          index: i - 1,
          value,
          at: performance.now(),
          deadline,
        });
        el.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: s.pointerId,
            pointerType: 'mouse',
            buttons: 1,
            clientX: startX + (value * rect.width) / range,
            clientY: rect.y + rect.height / 2,
          }),
        );
      }
      // One complete 1000ms sweep, including the last tick's dispatch window.
      // Never wait for a reply; final pointer-up/refine gets a distinct phase.
      const remaining = started + 1000 - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      s.sweepEnd = performance.now();
      s.phase = 'final-fence';
    },
    { arm, maximum },
  );
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', String(maximum));
  await fenceDetailRequests(page);
  const raw = await page.evaluate(() => (window as any).__detailPerf);
  const attr = {
    sharpen: 'crs:Sharpness',
    nrColor: 'crs:ColorNoiseReduction',
    nrLuminance: 'crs:LuminanceSmoothing',
  }[arm];
  if (!attr) throw new Error('Unknown detail arm');
  const samples = raw.inputs.map((input: any) => {
    const requests = raw.requests.filter(
      (r: any) =>
        r.phase === 'sweep' &&
        r.input === input.index &&
        (route === 'gpu'
          ? r.type === 'render-session'
          : r.type === 'decode' && r.qualityPreview === true),
    );
    const req = requests.length === 1 ? requests[0] : null;
    const match = req?.xmp.match(new RegExp(`${attr}="([^"]+)"`));
    const response =
      req &&
      raw.replies.find(
        (r: any) =>
          r.key === req.key &&
          r.type === (route === 'gpu' ? 'render-session-success' : 'decode-success'),
      );
    const publication =
      route === 'gpu' ? response : req && raw.paints.find((p: any) => p.key === req.key);
    return {
      ...input,
      request: req,
      reply: response,
      publication,
      valueMatches:
        Number(
          match?.[1] ??
            DEFAULT_MODEL[arm === 'sharpen' ? 'sharpenAmount' : (arm as 'nrColor' | 'nrLuminance')],
        ) === input.value,
      latencyMs: publication ? publication.at - input.at : null,
    };
  });
  return {
    arm,
    route,
    clock:
      route === 'gpu'
        ? 'input-to-worker-GPU-submission-ack; excludes GPU completion/scanout'
        : 'input-to-main-thread-canvas-draw; excludes compositor/scanout',
    samples,
    raw,
  };
}

export function assertDetailSweep(report: Awaited<ReturnType<typeof sweepDetail>>) {
  const { samples, raw } = report;
  expect(samples).toHaveLength(60);
  expect(raw.ambiguous).toBe(0);
  expect(new Set(samples.map((s: any) => s.request?.key)).size).toBe(60);
  expect(raw.replies.filter((r: any) => /error/.test(r.type))).toHaveLength(0);
  for (const sample of samples) {
    expect(sample.valueMatches).toBe(true);
    expect(sample.publication).toBeTruthy();
    expect(Number.isFinite(sample.latencyMs)).toBe(true);
    expect(sample.latencyMs).toBeGreaterThanOrEqual(0);
    expect(sample.latencyMs).toBeLessThanOrEqual(16);
    expect(sample.latencyMs).toBeLessThanOrEqual(50);
    // Delivery cannot silently degrade to a slower rate and pass render gates.
    expect(Math.abs(sample.at - sample.deadline)).toBeLessThanOrEqual(16);
  }
  const span = samples.at(-1).at - samples[0].at;
  expect(59_000 / span).toBeGreaterThanOrEqual(59);
  expect(59_000 / span).toBeLessThanOrEqual(61);
}
