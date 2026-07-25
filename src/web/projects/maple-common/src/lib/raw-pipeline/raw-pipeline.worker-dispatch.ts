// Worker message dispatch — extracted from `raw-pipeline.service.ts` (#2314) so
// that file stays inside the 600-line hard budget. This was the single largest
// concern left in the service: the `message` listener's per-response-type routing,
// which had grown to cover every request kind (legacy decode, scene-linear decode,
// GPU sessions, auto-adjust, export) plus two broadcast-only concerns bolted on
// alongside it (T10 threaded-state, #1153 deep-denoise progress).
//
// Pure function over the incoming `WorkerResponse` plus the service's own mutable
// state (the pending-handler registry, the threaded-state subjects, and the
// deep-denoise progress signal) — `RawPipelineService.ensureWorker` wires this as
// its `message` listener and keeps ownership of creating/tearing down the worker
// itself. Pure code move: no behaviour change.

import type { BehaviorSubject } from 'rxjs';
import type { WritableSignal } from '@angular/core';
import type { DecodedImage, ScopeSnapshot, WorkerResponse } from './raw-pipeline.types';
import type { PendingHandler } from './raw-pipeline.service-internals';

/** Pack a worker `ScopeSnapshot` reply into a `DecodedImage` for `currentPixels`. */
export function scopeToDecoded(scope: ScopeSnapshot | undefined): DecodedImage | undefined {
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
  if (msg.type === 'decode-success' && handler.kind === 'legacy') {
    handler.resolve({
      width: msg.width,
      height: msg.height,
      nativeWidth: msg.nativeWidth,
      nativeHeight: msg.nativeHeight,
      rgb: new Uint8Array(msg.rgb),
      asShotTemperature: msg.asShotTemperature,
      asShotTint: msg.asShotTint,
    });
  } else if (msg.type === 'decode-error' && handler.kind === 'legacy') {
    handler.reject(new Error(msg.message));
  } else if (msg.type === 'decode-scene-linear-success' && handler.kind === 'scene-linear') {
    handler.resolve({
      width: msg.width,
      height: msg.height,
      nativeWidth: msg.nativeWidth,
      nativeHeight: msg.nativeHeight,
      fp16Rgba: new Uint16Array(msg.fp16Rgba),
      asShotTemperature: msg.asShotTemperature,
      asShotTint: msg.asShotTint,
    });
  } else if (msg.type === 'decode-scene-linear-error' && handler.kind === 'scene-linear') {
    handler.reject(new Error(msg.message));
  } else if (msg.type === 'open-session-success' && handler.kind === 'open-session') {
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
  } else if (msg.type === 'render-session-success' && handler.kind === 'render-session') {
    handler.resolve({
      colorSpace: msg.colorSpace,
      scopePixels: scopeToDecoded(msg.scope),
    });
  } else if (
    msg.type === 'session-error' &&
    (handler.kind === 'open-session' || handler.kind === 'render-session')
  ) {
    handler.reject(new Error(msg.message));
  } else if (msg.type === 'auto-adjust-success' && handler.kind === 'auto-adjust') {
    handler.resolve(msg.patch);
  } else if (msg.type === 'auto-adjust-error' && handler.kind === 'auto-adjust') {
    handler.reject(new Error(msg.message));
  } else if (msg.type === 'export-success' && handler.kind === 'export') {
    handler.resolve({
      width: msg.width,
      height: msg.height,
      extension: msg.extension,
      blob: msg.blob,
    });
  } else if (msg.type === 'export-error' && handler.kind === 'export') {
    handler.reject(new Error(msg.message));
  } else {
    // Mismatched response type and handler kind — should never happen because ids
    // are unique and the worker only emits success/error matching the request
    // type. Reject defensively to avoid hangs.
    handler.reject(new Error(`raw-pipeline: handler kind mismatch (${msg.type})`));
  }
}
