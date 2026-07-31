import { Injectable, computed, signal } from '@angular/core';
import type { AssetId } from '../models/asset';

export type SidecarSavePhase = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

interface AssetSaveState {
  revision: number;
  phase: SidecarSavePhase;
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class SidecarSaveStateService {
  private readonly _assets = signal(new Map<AssetId, AssetSaveState>());

  readonly phase = computed<SidecarSavePhase>(() => {
    const phases = [...this._assets().values()].map((state) => state.phase);
    if (phases.includes('error')) return 'error';
    if (phases.includes('saving')) return 'saving';
    if (phases.includes('unsaved')) return 'unsaved';
    if (phases.includes('saved')) return 'saved';
    return 'idle';
  });
  readonly error = computed(
    () => [...this._assets().values()].find((state) => state.error)?.error ?? null,
  );
  readonly hasUnsavedChanges = computed(() =>
    [...this._assets().values()].some((state) =>
      ['unsaved', 'saving', 'error'].includes(state.phase),
    ),
  );

  queued(assetId: AssetId): number {
    const revision = (this._assets().get(assetId)?.revision ?? 0) + 1;
    this.set(assetId, { revision, phase: 'unsaved', error: null });
    return revision;
  }

  saving(assetId: AssetId, revision: number): void {
    if (!this.isCurrent(assetId, revision)) return;
    this.updatePhase(assetId, revision, 'saving');
  }

  saved(assetId: AssetId, revision: number): void {
    if (!this.isCurrent(assetId, revision)) return;
    this.set(assetId, { revision, phase: 'saved', error: null });
  }

  failed(assetId: AssetId, revision: number, error: unknown): void {
    if (!this.isCurrent(assetId, revision)) return;
    this.set(assetId, {
      revision,
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private isCurrent(assetId: AssetId, revision: number): boolean {
    return this._assets().get(assetId)?.revision === revision;
  }

  private updatePhase(assetId: AssetId, revision: number, phase: SidecarSavePhase): void {
    const current = this._assets().get(assetId);
    this.set(assetId, { revision, phase, error: current?.error ?? null });
  }

  private set(assetId: AssetId, state: AssetSaveState): void {
    this._assets.update((assets) => {
      const next = new Map(assets);
      next.set(assetId, state);
      return next;
    });
  }
}
