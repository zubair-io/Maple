import type { Page } from '@playwright/test';
import { buildLiveParams } from '../../projects/maple-common/src/lib/components/image-canvas/image-canvas.live-params';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';

export interface HighlightTick {
  readonly workerId: number;
  readonly requestId: number;
  readonly maxLongEdge: number | null;
  readonly qualityPreview: boolean | null;
  readonly sourceBytes: number | null;
  readonly replyWidth: number | null;
  readonly replyHeight: number | null;
  readonly nativeWidth: number | null;
  readonly nativeHeight: number | null;
  readonly inputAt: number;
  readonly domValueAtDispatch: string | null;
  readonly route: string;
  readonly encodedHighlights: number | null;
  readonly dispatchAt: number;
  readonly replyAt: number;
  readonly frameAt: number;
}

// Qualification instrumentation only. Production requests, replies and draws
// remain untouched; every timestamp belongs to the browser's monotonic clock.
export async function installHighlightsMeter(page: Page): Promise<void> {
  const initial = buildLiveParams(defaultAdjustmentModel());
  const changed = buildLiveParams({ ...defaultAdjustmentModel(), highlights: 1 });
  const indices = [...changed.keys()].filter((index) => changed[index] !== initial[index]);
  if (indices.length !== 1)
    throw new Error('Production serializer did not identify one Highlights field');
  await page.addInitScript((highlightIndex) => {
    const meter = {
      inputAt: 0,
      sequence: 0,
      workerSequence: 0,
      rows: [] as HighlightTick[],
      chronology: [] as Record<string, unknown>[],
    };
    Reflect.set(window, '__mapleHighlightsMeter', meter);
    document.addEventListener(
      'keydown',
      (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.getAttribute('aria-label') === 'Highlights') {
          meter.inputAt = performance.now();
          meter.sequence += 1;
        }
      },
      true,
    );
    const NativeWorker = window.Worker;
    Reflect.set(
      window,
      'Worker',
      new Proxy(NativeWorker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget) as Worker;
          const workerId = ++meter.workerSequence;
          const pending = new Map<
            number,
            Omit<
              HighlightTick,
              'replyAt' | 'frameAt' | 'replyWidth' | 'replyHeight' | 'nativeWidth' | 'nativeHeight'
            >
          >();
          const post = worker.postMessage.bind(worker);
          worker.postMessage = ((message: Record<string, unknown>, ...options: unknown[]) => {
            meter.chronology.push({
              direction: 'request',
              workerId,
              at: performance.now(),
              id: message['id'],
              type: message['type'],
              inputAt: meter.inputAt,
              maxLongEdge: message['maxLongEdge'] ?? null,
              qualityPreview: message['qualityPreview'] ?? null,
            });
            if (
              meter.inputAt &&
              (message['type'] === 'render-session' || message['type'] === 'decode')
            ) {
              pending.set(Number(message['id']), {
                workerId,
                requestId: Number(message['id']),
                maxLongEdge:
                  typeof message['maxLongEdge'] === 'number' ? message['maxLongEdge'] : null,
                qualityPreview:
                  typeof message['qualityPreview'] === 'boolean' ? message['qualityPreview'] : null,
                sourceBytes:
                  message['bytes'] instanceof ArrayBuffer ? message['bytes'].byteLength : null,
                inputAt: meter.inputAt,
                domValueAtDispatch:
                  document
                    .querySelector('[aria-label="Highlights"]')
                    ?.getAttribute('aria-valuenow') ?? null,
                encodedHighlights:
                  message['params'] instanceof Float32Array
                    ? message['params'][highlightIndex]
                    : typeof message['xmp'] === 'string'
                      ? Number(
                          message['xmp'].match(/crs:Highlights2012="([^"]+)"/)?.[1] ?? Number.NaN,
                        )
                      : null,
                route: String(message['type']),
                dispatchAt: performance.now(),
              });
            }
            Reflect.apply(post, worker, [message, ...options]);
          }) as Worker['postMessage'];
          worker.addEventListener('message', (event) => {
            const data = event.data as {
              id: number;
              type: string;
              width?: number;
              height?: number;
              nativeWidth?: number;
              nativeHeight?: number;
            };
            meter.chronology.push({
              direction: 'reply',
              workerId,
              at: performance.now(),
              id: data.id,
              type: data.type,
              width: data.width ?? null,
              height: data.height ?? null,
              nativeWidth: data.nativeWidth ?? null,
              nativeHeight: data.nativeHeight ?? null,
            });
            const input = pending.get(data.id);
            if (!input) return;
            pending.delete(data.id);
            if (!['render-session-success', 'decode-success'].includes(data.type)) return;
            const row = {
              ...input,
              replyWidth: data.width ?? null,
              replyHeight: data.height ?? null,
              nativeWidth: data.nativeWidth ?? null,
              nativeHeight: data.nativeHeight ?? null,
              replyAt: performance.now(),
              frameAt: 0,
            };
            if (data.type === 'render-session-success') {
              // The worker has actually submitted/presented the OffscreenCanvas.
              // Crossing a main-thread frame is observable, but not hardware scanout.
              requestAnimationFrame(() => {
                row.frameAt = performance.now();
                meter.rows.push(row);
              });
            } else {
              Reflect.set(window, '__mapleHighlightsPendingPaint', row);
            }
          });
          return worker;
        },
      }),
    );
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      image: CanvasImageSource,
      ...coordinates: number[]
    ) {
      Reflect.apply(draw, this, [image, ...coordinates]);
      const surface = this.canvas;
      if (!(surface instanceof HTMLCanvasElement) || !surface.closest('editor-image-canvas'))
        return;
      const row = Reflect.get(window, '__mapleHighlightsPendingPaint') as HighlightTick | undefined;
      if (!row) return;
      Reflect.deleteProperty(window, '__mapleHighlightsPendingPaint');
      requestAnimationFrame(() => {
        meter.rows.push({ ...row, frameAt: performance.now() });
      });
    };
  }, indices[0]);
}

export async function highlightTicks(page: Page): Promise<HighlightTick[]> {
  return page.evaluate(
    () => (Reflect.get(window, '__mapleHighlightsMeter') as { rows: HighlightTick[] }).rows,
  );
}

export async function highlightsChronology(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    () =>
      (Reflect.get(window, '__mapleHighlightsMeter') as { chronology: Record<string, unknown>[] })
        .chronology,
  );
}
