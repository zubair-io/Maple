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

type PendingTick = Omit<
  HighlightTick,
  'replyAt' | 'frameAt' | 'replyWidth' | 'replyHeight' | 'nativeWidth' | 'nativeHeight'
>;
type WorkerRequest = Record<string, unknown>;

interface WorkerReply {
  readonly id: number;
  readonly type: string;
  readonly width?: number;
  readonly height?: number;
  readonly nativeWidth?: number;
  readonly nativeHeight?: number;
}

interface Meter {
  readonly highlightIndex: number;
  readonly rows: HighlightTick[];
  readonly chronology: Record<string, unknown>[];
  inputAt: number;
  workerSequence: number;
  pendingPaint: HighlightTick | null;
}

// Every function below runs inside the page: they are serialized into one
// init script, so they may reference only each other and browser globals.
function meter(): Meter {
  return Reflect.get(window, '__mapleHighlightsMeter') as Meter;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function encodedHighlights(message: WorkerRequest): number | null {
  const params = message['params'];
  if (params instanceof Float32Array) return params[meter().highlightIndex];
  const xmp = message['xmp'];
  if (typeof xmp !== 'string') return null;
  return Number(xmp.match(/crs:Highlights2012="([^"]+)"/)?.[1] ?? Number.NaN);
}

function pendingTick(workerId: number, message: WorkerRequest): PendingTick {
  const bytes = message['bytes'];
  const slider = document.querySelector('[aria-label="Highlights"]');
  return {
    workerId,
    requestId: Number(message['id']),
    maxLongEdge: numberOrNull(message['maxLongEdge']),
    qualityPreview: booleanOrNull(message['qualityPreview']),
    sourceBytes: bytes instanceof ArrayBuffer ? bytes.byteLength : null,
    inputAt: meter().inputAt,
    domValueAtDispatch: slider?.getAttribute('aria-valuenow') ?? null,
    encodedHighlights: encodedHighlights(message),
    route: String(message['type']),
    dispatchAt: performance.now(),
  };
}

function recordRequest(
  workerId: number,
  message: WorkerRequest,
  pending: Map<number, PendingTick>,
): void {
  const state = meter();
  state.chronology.push({
    direction: 'request',
    workerId,
    at: performance.now(),
    id: message['id'],
    type: message['type'],
    inputAt: state.inputAt,
    maxLongEdge: numberOrNull(message['maxLongEdge']),
    qualityPreview: booleanOrNull(message['qualityPreview']),
  });
  const measuredRoute = ['render-session', 'decode'].includes(String(message['type']));
  if (state.inputAt > 0 && measuredRoute)
    pending.set(Number(message['id']), pendingTick(workerId, message));
}

function replyDimensions(reply: WorkerReply) {
  return {
    replyWidth: reply.width ?? null,
    replyHeight: reply.height ?? null,
    nativeWidth: reply.nativeWidth ?? null,
    nativeHeight: reply.nativeHeight ?? null,
  };
}

function pushAtNextFrame(row: HighlightTick): void {
  requestAnimationFrame(() => meter().rows.push({ ...row, frameAt: performance.now() }));
}

function recordReply(workerId: number, reply: WorkerReply, pending: Map<number, PendingTick>) {
  const state = meter();
  const at = performance.now();
  state.chronology.push({ direction: 'reply', workerId, at, id: reply.id, type: reply.type });
  const input = pending.get(reply.id);
  pending.delete(reply.id);
  if (!input || !['render-session-success', 'decode-success'].includes(reply.type)) return;
  const row = { ...input, ...replyDimensions(reply), replyAt: at, frameAt: 0 };
  // A render-session success means the worker already presented its OffscreenCanvas;
  // a decode success still has to be drawn by the main thread.
  if (reply.type === 'render-session-success') pushAtNextFrame(row);
  else state.pendingPaint = row;
}

function meterWorker(worker: Worker): Worker {
  const workerId = ++meter().workerSequence;
  const pending = new Map<number, PendingTick>();
  const post = worker.postMessage.bind(worker);
  worker.postMessage = ((message: WorkerRequest, ...options: unknown[]) => {
    recordRequest(workerId, message, pending);
    Reflect.apply(post, worker, [message, ...options]);
  }) as Worker['postMessage'];
  worker.addEventListener('message', (event) =>
    recordReply(workerId, event.data as WorkerReply, pending),
  );
  return worker;
}

function recordPaint(surface: HTMLCanvasElement | OffscreenCanvas): void {
  const state = meter();
  const row = state.pendingPaint;
  const editorSurface =
    surface instanceof HTMLCanvasElement && !!surface.closest('editor-image-canvas');
  if (!row || !editorSurface) return;
  state.pendingPaint = null;
  pushAtNextFrame(row);
}

function meterCanvasDraws(): void {
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (
    this: CanvasRenderingContext2D,
    ...args: unknown[]
  ) {
    Reflect.apply(draw, this, args);
    recordPaint(this.canvas);
  } as CanvasRenderingContext2D['drawImage'];
}

function installMeter(highlightIndex: number): void {
  const state: Meter = {
    highlightIndex,
    rows: [],
    chronology: [],
    inputAt: 0,
    workerSequence: 0,
    pendingPaint: null,
  };
  Reflect.set(window, '__mapleHighlightsMeter', state);
  document.addEventListener(
    'keydown',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.getAttribute('aria-label') === 'Highlights') state.inputAt = performance.now();
    },
    true,
  );
  const construct = (target: typeof Worker, args: unknown[], newTarget: Function) =>
    meterWorker(Reflect.construct(target, args, newTarget) as Worker);
  Reflect.set(window, 'Worker', new Proxy(window.Worker, { construct }));
  meterCanvasDraws();
}

const IN_PAGE_METER = [
  meter,
  numberOrNull,
  booleanOrNull,
  encodedHighlights,
  pendingTick,
  recordRequest,
  replyDimensions,
  pushAtNextFrame,
  recordReply,
  meterWorker,
  recordPaint,
  meterCanvasDraws,
  installMeter,
];

function productionHighlightsIndex(): number {
  const initial = buildLiveParams(defaultAdjustmentModel());
  const changed = buildLiveParams({ ...defaultAdjustmentModel(), highlights: 1 });
  const indices = [...changed.keys()].filter((index) => changed[index] !== initial[index]);
  if (indices.length !== 1)
    throw new Error('Production serializer did not identify one Highlights field');
  return indices[0];
}

// Qualification instrumentation only: production requests, replies and draws
// pass through untouched, and every timestamp is the page's monotonic clock.
export async function installHighlightsMeter(page: Page): Promise<void> {
  const helpers = IN_PAGE_METER.map(String).join('\n');
  await page.addInitScript({
    content: `(() => {\n${helpers}\ninstallMeter(${productionHighlightsIndex()});\n})();`,
  });
}

export async function highlightTicks(page: Page): Promise<HighlightTick[]> {
  return page.evaluate(() => (Reflect.get(window, '__mapleHighlightsMeter') as Meter).rows);
}

export async function highlightsChronology(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => (Reflect.get(window, '__mapleHighlightsMeter') as Meter).chronology);
}
