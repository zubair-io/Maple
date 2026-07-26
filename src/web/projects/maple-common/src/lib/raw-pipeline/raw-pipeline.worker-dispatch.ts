// Worker message dispatch — extracted from `raw-pipeline.service.ts` (#2314) so
// that file stays inside the 600-line hard budget. This was the single largest
// concern left in the service: the `message` listener's per-response-type routing,
// which had grown to cover every request kind (legacy decode, scene-linear decode,
// GPU sessions, auto-adjust, export) plus two broadcast-only concerns bolted on
// alongside it (T10 threaded-state, #1153 deep-denoise progress).
//
// Side-effecting dispatcher, not a pure function: it logs to the console, pushes
// onto the threaded-state subjects, writes the deep-denoise progress signal, and
// settles entries in the pending-handler registry. Those effects are the point —
// it takes the service's own mutable state as `ctx` rather than owning any, and
// `RawPipelineService.ensureWorker` wires it as the `message` listener while
// keeping ownership of creating/tearing down the worker itself.
//
// Extracted as a pure code move: no behaviour change.

import type { BehaviorSubject } from 'rxjs';
import type { WritableSignal } from '@angular/core';
import type { DecodedImage, ScopeSnapshot, WorkerResponse } from './raw-pipeline.types';
import type { PendingHandler } from './raw-pipeline.service-internals';

// Module-local: this was a private method on `RawPipelineService` and has no
// consumer outside this file. Exporting it would be dead surface area.
/** Pack a worker `ScopeSnapshot` reply into a `DecodedImage` for `currentPixels`. */
function scopeToDecoded(scope: ScopeSnapshot | undefined): DecodedImage | undefined {
  if (!scope) return undefined;
  return {
    width: scope.width,
    height: scope.height,
    rgb: new Uint8Array(scope.rgb),
    // The scopes ignore WB; these are placeholders (a readback has no As-Shot WB).
    asShotTemperature: 6500,
    asShotTint: 0,
  };
}

// Each `settle*` below owns exactly one `PendingHandler.kind` and returns whether
// it recognised `msg`. A `false` return falls through to the shared mismatch
// rejection in `settle`, which is what the original single if/else chain did when
// no `(msg.type, handler.kind)` pair matched — the split is by handler kind only,
// and every branch already tested that kind, so the outcomes are unchanged.

type Settler<K extends PendingHandler['kind']> = (
  msg: WorkerResponse,
  handler: Extract<PendingHandler, { kind: K }>,
) => boolean;

const settleLegacy: Settler<'legacy'> = (msg, handler) => {
  if (msg.type === 'decode-success') {
    handler.resolve({
      width: msg.width,
      height: msg.height,
      nativeWidth: msg.nativeWidth,
      nativeHeight: msg.nativeHeight,
      rgb: new Uint8Array(msg.rgb),
      asShotTemperature: msg.asShotTemperature,
      asShotTint: msg.asShotTint,
    });
    return true;
  }
  if (msg.type === 'decode-error') {
    handler.reject(new Error(msg.message));
    return true;
  }
  return false;
};

const settleSceneLinear: Settler<'scene-linear'> = (msg, handler) => {
  if (msg.type === 'decode-scene-linear-success') {
    handler.resolve({
      width: msg.width,
      height: msg.height,
      nativeWidth: msg.nativeWidth,
      nativeHeight: msg.nativeHeight,
      fp16Rgba: new Uint16Array(msg.fp16Rgba),
      asShotTemperature: msg.asShotTemperature,
      asShotTint: msg.asShotTint,
    });
    return true;
  }
  if (msg.type === 'decode-scene-linear-error') {
    handler.reject(new Error(msg.message));
    return true;
  }
  return false;
};

const settleOpenSession: Settler<'open-session'> = (msg, handler) => {
  if (msg.type === 'open-session-success') {
    handler.resolve({
      width: msg.width,
      height: msg.height,
      nativeWidth: msg.nativeWidth,
      nativeHeight: msg.nativeHeight,
      asShotTemperature: msg.asShotTemperature,
      asShotTint: msg.asShotTint,
      colorSpace: msg.colorSpace,
      scopePixels: scopeToDecoded(msg.scope),
    });
    return true;
  }
  if (msg.type === 'session-error') {
    handler.reject(new Error(msg.message));
    return true;
  }
  return false;
};

const settleRenderSession: Settler<'render-session'> = (msg, handler) => {
  if (msg.type === 'render-session-success') {
    handler.resolve({
      colorSpace: msg.colorSpace,
      scopePixels: scopeToDecoded(msg.scope),
    });
    return true;
  }
  if (msg.type === 'session-error') {
    handler.reject(new Error(msg.message));
    return true;
  }
  return false;
};

const settleAutoAdjust: Settler<'auto-adjust'> = (msg, handler) => {
  if (msg.type === 'auto-adjust-success') {
    handler.resolve(msg.patch);
    return true;
  }
  if (msg.type === 'auto-adjust-error') {
    handler.reject(new Error(msg.message));
    return true;
  }
  return false;
};

const settleExport: Settler<'export'> = (msg, handler) => {
  if (msg.type === 'export-success') {
    handler.resolve({
      width: msg.width,
      height: msg.height,
      extension: msg.extension,
      blob: msg.blob,
    });
    return true;
  }
  if (msg.type === 'export-error') {
    handler.reject(new Error(msg.message));
    return true;
  }
  return false;
};

/** Pick the settler for `handler.kind` and report whether it recognised `msg`. */
function settleByKind(msg: WorkerResponse, handler: PendingHandler): boolean {
  switch (handler.kind) {
    case 'legacy':
      return settleLegacy(msg, handler);
    case 'scene-linear':
      return settleSceneLinear(msg, handler);
    case 'open-session':
      return settleOpenSession(msg, handler);
    case 'render-session':
      return settleRenderSession(msg, handler);
    case 'auto-adjust':
      return settleAutoAdjust(msg, handler);
    case 'export':
      return settleExport(msg, handler);
  }
}

/** Hand `msg` to the settler for `handler.kind`, rejecting if it goes unrecognised. */
function settle(msg: WorkerResponse, handler: PendingHandler): void {
  if (settleByKind(msg, handler)) return;
  // Mismatched response type and handler kind — should never happen because ids
  // are unique and the worker only emits success/error matching the request
  // type. Reject defensively to avoid hangs.
  handler.reject(new Error(`raw-pipeline: handler kind mismatch (${msg.type})`));
}

/** The service state one `handleWorkerMessage` call reads and/or updates. */
export interface WorkerDispatchContext {
  pending: Map<number, PendingHandler>;
  threadedSubject: BehaviorSubject<boolean | null>;
  threadCountSubject: BehaviorSubject<number>;
  deepDenoiseProgress: WritableSignal<{ pass: 1 | 2; fraction: number } | null>;
}

/**
 * Route one `WorkerResponse` to its pending handler, or fold it into the
 * broadcast-only state (`status` / `worker-log` / `deep-denoise-progress` carry
 * id 0 and have no pending handler). Pure code move out of `ensureWorker`'s
 * `message` listener — no behaviour change.
 */
export function handleWorkerMessage(msg: WorkerResponse, ctx: WorkerDispatchContext): void {
  if (msg.type === 'worker-log') {
    const prefix = '[raw-pipeline worker]';
    if (msg.level === 'error') console.error(prefix, msg.text);
    else if (msg.level === 'warn') console.warn(prefix, msg.text);
    else console.log(prefix, msg.text);
    return;
  }
  if (msg.type === 'status') {
    ctx.threadedSubject.next(msg.threaded);
    ctx.threadCountSubject.next(msg.threads);
    return;
  }
  if (msg.type === 'deep-denoise-progress') {
    ctx.deepDenoiseProgress.set({ pass: msg.pass, fraction: msg.fraction });
    return;
  }
  const handler = ctx.pending.get(msg.id);
  if (!handler) return;
  ctx.pending.delete(msg.id);
  // Any terminal reply ends the develop that emitted the ticks.
  ctx.deepDenoiseProgress.set(null);
  settle(msg, handler);
}
