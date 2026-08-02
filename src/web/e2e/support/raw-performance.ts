import { expect, type Locator, type Page, type Worker as PlaywrightWorker } from '@playwright/test';

export interface WorkerStatus {
  readonly threaded: boolean;
  readonly threads: number;
}

export interface PixelEvidence {
  readonly width: number;
  readonly height: number;
  readonly range: number;
  readonly nonDarkFraction: number;
}

async function settleWithin<T>(promise: Promise<T>, fallback: T, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureWorkerStatus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const statuses: WorkerStatus[] = [];
    Object.defineProperty(window, '__mapleWorkerStatuses', {
      configurable: false,
      value: statuses,
    });
    const NativeWorker = window.Worker;
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget) as Worker;
          worker.addEventListener('message', (event: MessageEvent) => {
            if (event.data?.type === 'status') {
              statuses.push({
                threaded: event.data.threaded === true,
                threads: Number(event.data.threads),
              });
            }
          });
          return worker;
        },
      }),
    });
  });
}

export async function forceNoWebGpu(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let owner: object | null = navigator;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, 'gpu')) {
      owner = Object.getPrototypeOf(owner);
    }
    if (owner) Reflect.deleteProperty(owner, 'gpu');
  });
}

export async function workerStatus(page: Page): Promise<WorkerStatus | null> {
  return page.evaluate(() => {
    const statuses = (window as typeof window & { __mapleWorkerStatuses?: readonly WorkerStatus[] })
      .__mapleWorkerStatuses;
    return statuses?.at(-1) ?? null;
  });
}

export async function screenshotPixelEvidence(locator: Locator): Promise<PixelEvidence> {
  const screenshot = await locator.screenshot({ type: 'png' });
  return locator.page().evaluate(async (base64) => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Chrome did not provide a 2D screenshot readback context');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minimum = 255;
    let maximum = 0;
    let nonDark = 0;
    let sampled = 0;
    for (let index = 0; index < pixels.length; index += 16) {
      const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      minimum = Math.min(minimum, luminance);
      maximum = Math.max(maximum, luminance);
      if (luminance > 8) nonDark += 1;
      sampled += 1;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      range: maximum - minimum,
      nonDarkFraction: nonDark / sampled,
    };
  }, screenshot.toString('base64'));
}

export async function rawWorker(
  page: Page,
  observedWorkers: readonly PlaywrightWorker[],
): Promise<PlaywrightWorker> {
  let match: PlaywrightWorker | null = null;
  await expect
    .poll(async () => {
      const candidates = [...new Set([...observedWorkers, ...page.workers()])];
      for (const worker of candidates) {
        try {
          const ownsSession = await settleWithin(
            worker.evaluate(() =>
              performance
                .getEntriesByType('measure')
                .some((entry) => entry.name === 'maple:session-open'),
            ),
            false,
          );
          if (ownsSession) {
            match = worker;
            return true;
          }
        } catch {
          // A short-lived thumbnail worker can disappear while candidates are inspected.
        }
      }
      return false;
    })
    .toBe(true);
  if (!match) throw new Error('No worker owned the completed RAW live session');
  return match;
}

export async function sessionRenderDurations(worker: PlaywrightWorker): Promise<number[]> {
  return settleWithin(
    worker.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .filter((entry) => entry.name === 'maple:session-render')
        .map((entry) => entry.duration),
    ),
    [],
  );
}

export async function sessionOpenDuration(worker: PlaywrightWorker): Promise<number> {
  return settleWithin(
    worker.evaluate(() => {
      const duration = performance
        .getEntriesByType('measure')
        .find((entry) => entry.name === 'maple:session-open')?.duration;
      if (duration === undefined)
        throw new Error('RAW worker has no completed session-open measure');
      return duration;
    }),
    Number.NaN,
  );
}

export function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
