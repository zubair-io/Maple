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

import { signal, type Signal } from '@angular/core';

import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';

/**
 * Minimal LibraryStateService stand-in: holds the AdjustmentModel signal,
 * exposes `adjustmentFor`, and applies `updateAdjustment` patches in place
 * (mirroring the real store's behavior without standing up the API +
 * sidecar machinery).
 */
export class LibraryStub {
  private models = new Map<string, ReturnType<typeof signal<AdjustmentModel>>>();
  private asShot = new Map<string, { temperature: number; tint: number }>();

  // Minimal asset list — used by applyAuto to resolve the file extension.
  assets = signal([{ id: 'asset-1', filename: 'test.dng' }] as Array<{
    id: string;
    filename: string;
  }>);

  // Synchronous bytes cache (populated per-test for applyAuto).
  private bytesCache = new Map<string, Uint8Array>();

  primeBytes(id: string, bytes: Uint8Array): void {
    this.bytesCache.set(id, bytes);
  }

  bytesFor(id: string): Uint8Array | undefined {
    return this.bytesCache.get(id);
  }

  bytesForAsset(id: string): Promise<Uint8Array> {
    const b = this.bytesCache.get(id);
    return b ? Promise.resolve(b) : Promise.reject(new Error(`no bytes for ${id}`));
  }

  ensure(id: string): void {
    if (!this.models.has(id)) {
      this.models.set(id, signal(defaultAdjustmentModel()));
    }
  }

  adjustmentFor(id: string): Signal<AdjustmentModel> {
    this.ensure(id);
    return this.models.get(id)!.asReadonly();
  }

  /** #1153: every call is one model write, i.e. one re-render/decode kick. */
  updateCount = 0;

  updateAdjustment(id: string, patch: Partial<AdjustmentModel>): void {
    this.updateCount += 1;
    this.ensure(id);
    this.models.get(id)!.update((m) => ({ ...m, ...patch }));
  }

  /** Test seam: stage a camera As-Shot reading for `id`. */
  setAsShot(id: string, wb: { temperature: number; tint: number }): void {
    this.asShot.set(id, wb);
  }

  asShotWbFor(id: string): { temperature: number; tint: number } | undefined {
    return this.asShot.get(id);
  }
}
