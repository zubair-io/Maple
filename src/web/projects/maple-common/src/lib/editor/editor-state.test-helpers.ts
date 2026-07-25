// editor-state.test-helpers.ts — shared test double for the EditorStateService specs.
//
// Extracted from `editor-state.service.spec.ts` (#1153) so the
// commit-on-release suite in `editor-state.commit-on-release.spec.ts` can
// drive the same store stand-in without a second copy, and so neither spec
// file carries the harness against the file-size budget.
//
// Deliberately framework-free (no `vitest` import): it only needs Angular
// signals and the adjustment model, which keeps it safe to sit alongside
// library sources that the production build type-checks.

import { signal, type Signal, type WritableSignal } from '@angular/core';

import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

export interface LibraryStub {
  /**
   * Minimal asset list — used by applyAuto to resolve the file extension.
   * Writable: the stale-guard spec re-points it mid-test via `assets.set`.
   */
  readonly assets: WritableSignal<Array<{ id: string; filename: string }>>;
  /** #1153: every call is one model write, i.e. one re-render/decode kick. */
  updateCount: number;
  /** Test seam: stage decoded bytes for `id` (applyAuto's synchronous path). */
  primeBytes(id: string, bytes: Uint8Array): void;
  /** Test seam: stage a camera As-Shot reading for `id`. */
  setAsShot(id: string, wb: { temperature: number; tint: number }): void;
  bytesFor(id: string): Uint8Array | undefined;
  bytesForAsset(id: string): Promise<Uint8Array>;
  adjustmentFor(id: string): Signal<AdjustmentModel>;
  updateAdjustment(id: string, patch: Partial<AdjustmentModel>): void;
  asShotWbFor(id: string): { temperature: number; tint: number } | undefined;
}

/**
 * Minimal LibraryStateService stand-in: holds the AdjustmentModel signal,
 * exposes `adjustmentFor`, and applies `updateAdjustment` patches in place
 * (mirroring the real store's behavior without standing up the API +
 * sidecar machinery).
 *
 * Built as a closure over its state rather than a class: most of this surface
 * (`bytesFor`, `bytesForAsset`, `asShotWbFor`) is called by
 * `EditorStateService` through the injected `LibraryStateService`, never by
 * the specs directly, and only the state it captures is ever private.
 */
export function makeLibraryStub(): LibraryStub {
  const models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();
  const asShot = new Map<string, { temperature: number; tint: number }>();
  const bytesCache = new Map<string, Uint8Array>();

  const ensure = (id: string): ReturnType<typeof signal<AdjustmentModel>> => {
    const existing = models.get(id);
    if (existing) return existing;
    const created = signal(defaultAdjustmentModel());
    models.set(id, created);
    return created;
  };

  return {
    assets: signal([{ id: 'asset-1', filename: 'test.dng' }]),

    updateCount: 0,

    primeBytes(id, bytes) {
      bytesCache.set(id, bytes);
    },

    setAsShot(id, wb) {
      asShot.set(id, wb);
    },

    bytesFor(id) {
      return bytesCache.get(id);
    },

    bytesForAsset(id) {
      const b = bytesCache.get(id);
      return b ? Promise.resolve(b) : Promise.reject(new Error(`no bytes for ${id}`));
    },

    adjustmentFor(id) {
      return ensure(id).asReadonly();
    },

    updateAdjustment(id, patch) {
      this.updateCount += 1;
      ensure(id).update((m) => ({ ...m, ...patch }));
    },

    asShotWbFor(id) {
      return asShot.get(id);
    },
  };
}
