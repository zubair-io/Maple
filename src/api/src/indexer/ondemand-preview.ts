/**
 * On-demand (request-path) preview rendering for `GET /api/preview/:slug/*`
 * in the API process (#5433, replacing the #2012 limiter).
 *
 * A viewer waiting on a preview must not queue behind the background `preview`
 * stage's backlog, so this path has:
 *
 * - **Its own small cap**, independent of the stage's concurrency. It is a
 *   constant derived from the CPU count rather than a setting: it only bounds
 *   how many renders a burst of cache misses may run at once, and the stage
 *   yielding (below) is what actually buys the latency.
 * - **Priority over the stage.** While any on-demand render is pending, the
 *   worker child is told so over IPC and its stage stops admitting new renders
 *   (`workers/background-preview-gate.ts`). Its in-flight renders finish, so
 *   an on-demand render waits at most about one render's time for the CPU.
 * - **Coalescing.** Concurrent requests for one preview path share a single
 *   render. When the stage reports it is already rendering that path, the
 *   request waits for that render instead of starting a second.
 * - **Disconnect handling.** If every requester of a path has disconnected by
 *   the time a render slot frees up, the render is skipped. A render that has
 *   started always finishes and writes its file: the stage needs it anyway.
 */

import { availableParallelism } from 'node:os';
import { generatePreview, isPreviewCacheFresh } from './previewer.ts';
import type {
  PreviewInteractiveMessage,
  PreviewStageRenderMessage,
} from './preview-priority-protocol.ts';

/** A quarter of the cores, clamped to 2–4: enough for a burst of misses
 * without letting interactive renders become a backlog of their own. */
export const ONDEMAND_PREVIEW_CONCURRENCY = Math.min(
  4,
  Math.max(2, Math.floor(availableParallelism() / 4)),
);

/** Upper bound on waiting for a stage render whose `end` message never
 * arrives; the request then renders the preview itself. */
const STAGE_RENDER_WAIT_MS = 60_000;

type WorkerSender = (message: PreviewInteractiveMessage) => void;

interface PendingRender {
  /** One entry per requester; `null` for a caller that cannot disconnect. */
  signals: Array<AbortSignal | null>;
  promise: Promise<void>;
}

class OndemandPreviewRenderer {
  private running = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private readonly pending = new Map<string, PendingRender>();
  private readonly stageRenders = new Map<string, Array<() => void>>();
  private sender: WorkerSender | null = null;
  private announcedActive = false;

  /** Render `previewPath` from `absPath` unless the cache is fresh by the time
   * a slot is free. Resolves once the render settled or was skipped; callers
   * re-check freshness to learn which. */
  render(absPath: string, previewPath: string, signal?: AbortSignal): Promise<void> {
    const existing = this.pending.get(previewPath);
    if (existing) {
      existing.signals.push(signal ?? null);
      return existing.promise;
    }
    const entry: PendingRender = {
      signals: [signal ?? null],
      promise: Promise.resolve(),
    };
    entry.promise = this.renderOnce(entry, absPath, previewPath).finally(() => {
      this.pending.delete(previewPath);
      this.announce();
    });
    this.pending.set(previewPath, entry);
    this.announce();
    return entry.promise;
  }

  private async renderOnce(
    entry: PendingRender,
    absPath: string,
    previewPath: string,
  ): Promise<void> {
    await this.stageRenderSettled(previewPath);
    if (await isPreviewCacheFresh(previewPath, absPath)) return;
    await this.acquireSlot();
    try {
      if (entry.signals.every((signal) => signal?.aborted === true)) return;
      await generatePreview(absPath, previewPath);
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.running < ONDEMAND_PREVIEW_CONCURRENCY) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next) next();
    else this.running--;
  }

  private stageRenderSettled(previewPath: string): Promise<void> {
    const waiters = this.stageRenders.get(previewPath);
    if (!waiters) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, STAGE_RENDER_WAIT_MS);
    waiters.push(settle);
    return promise;
  }

  /** A `preview-stage-render` message from the worker child. */
  onStageRender(message: PreviewStageRenderMessage): void {
    if (message.phase === 'start') {
      if (!this.stageRenders.has(message.previewPath))
        this.stageRenders.set(message.previewPath, []);
      return;
    }
    const waiters = this.stageRenders.get(message.previewPath) ?? [];
    this.stageRenders.delete(message.previewPath);
    for (const wake of waiters) wake();
  }

  /** The worker child (re)spawned: tell it the current state straight away. */
  attachWorker(sender: WorkerSender): void {
    this.sender = sender;
    this.announcedActive = this.pending.size > 0;
    this.send(this.announcedActive);
  }

  /** The worker child died or was stopped: no stage render will report `end`. */
  detachWorker(): void {
    this.sender = null;
    const waiters = [...this.stageRenders.values()].flat();
    this.stageRenders.clear();
    for (const wake of waiters) wake();
  }

  private announce(): void {
    const active = this.pending.size > 0;
    if (active === this.announcedActive) return;
    this.announcedActive = active;
    this.send(active);
  }

  private send(active: boolean): void {
    try {
      this.sender?.({ type: 'preview-interactive', active });
    } catch {
      /* worker channel closed; the respawn re-attaches */
    }
  }
}

let renderer: OndemandPreviewRenderer | null = null;

/** Process-wide renderer. Lazily constructed on first call. */
export function ondemandPreviews(): OndemandPreviewRenderer {
  if (!renderer) renderer = new OndemandPreviewRenderer();
  return renderer;
}

/** Test-only: drop the singleton so the next call builds a fresh renderer. */
export function _resetOndemandPreviewsForTests(): void {
  renderer = null;
}

export type { OndemandPreviewRenderer };
