/**
 * Admission gate for the background `preview` stage's renders, in the worker
 * child (#5433).
 *
 * The stage claims and dispatches up to its `concurrency` handlers (50 on a
 * busy install), but the FFI pool's RAW lane can only execute as many renders
 * as it has children; the rest queue inside the pool, where nothing can
 * reprioritise them. This gate holds that excess queue here instead, admitting
 * at most as many renders as the RAW lane can run, and admitting none while the API process
 * reports an on-demand render pending (`indexer/ondemand-preview.ts`). The
 * renders already running finish, so a viewer's preview waits for at most
 * about one render before it has the CPU.
 *
 * The stage pauses for at most {@link MAX_YIELD_MS} per run of continuous
 * on-demand activity, so heavy browsing, or an `active: false` that never
 * arrives, cannot stop the backlog.
 *
 * Each admitted render is announced to the API process (`start` / `end`), so an
 * on-demand request for the same path waits for it instead of rendering twice.
 */

import { ffiPool } from '../ffi/ffi-pool.ts';
import {
  isPreviewInteractiveMessage,
  PREVIEW_PRIORITY_READY_MESSAGE,
  type PreviewStageRenderMessage,
} from '../indexer/preview-priority-protocol.ts';

const MAX_YIELD_MS = 10_000;

/** When the current run of on-demand activity began, or `null` when idle. */
let interactiveSince: number | null = null;
let running = 0;
const waiters = new Set<() => void>();

function wakeAll(): void {
  for (const wake of [...waiters]) wake();
}

function capacity(): number {
  return Math.max(1, ffiPool().poolSize());
}

export function setInteractivePreviewActive(active: boolean): void {
  if (!active) {
    interactiveSince = null;
    wakeAll();
    return;
  }
  interactiveSince ??= Date.now();
}

function yieldRemainingMs(): number {
  return interactiveSince === null ? 0 : interactiveSince + MAX_YIELD_MS - Date.now();
}

/** Worker boot: listen for the API process's interactive state, then ask for
 * it — a message sent before this listener existed was dropped. */
export function installWorkerPreviewPriority(): void {
  process.on('message', (message: unknown) => {
    if (isPreviewInteractiveMessage(message)) setInteractivePreviewActive(message.active);
  });
  send(PREVIEW_PRIORITY_READY_MESSAGE);
}

async function admit(): Promise<void> {
  for (;;) {
    const yieldMs = yieldRemainingMs();
    if (yieldMs <= 0 && running < capacity()) {
      running++;
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    const wake = (): void => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve();
    };
    const timer = yieldMs > 0 ? setTimeout(wake, yieldMs) : undefined;
    waiters.add(wake);
    await promise;
  }
}

function send(message: unknown): void {
  try {
    process.send?.(message);
  } catch {
    /* parent channel closed */
  }
}

function announce(previewPath: string, phase: PreviewStageRenderMessage['phase']): void {
  send({ type: 'preview-stage-render', previewPath, phase } satisfies PreviewStageRenderMessage);
}

export async function runBackgroundPreviewRender<T>(
  previewPath: string,
  render: () => Promise<T>,
): Promise<T> {
  await admit();
  announce(previewPath, 'start');
  try {
    return await render();
  } finally {
    announce(previewPath, 'end');
    running--;
    wakeAll();
  }
}

/** Test-only: forget all gate state. */
export function _resetBackgroundPreviewGateForTests(): void {
  interactiveSince = null;
  running = 0;
  wakeAll();
}

/** Test-only: renders currently admitted. */
export function _backgroundPreviewRendersRunning(): number {
  return running;
}
