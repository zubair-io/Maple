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
  private readonly _settledPhase = signal<SidecarSavePhase>('idle');
  private _nextRevision = 0;

  readonly phase = computed<SidecarSavePhase>(() => {
    let phase: SidecarSavePhase = this._settledPhase();
    for (const state of this._assets().values()) {
      if (state.phase === 'error') return 'error';
      if (state.phase === 'saving') phase = 'saving';
      else if (state.phase === 'unsaved' && phase !== 'saving') phase = 'unsaved';
    }
    return phase;
  });
  readonly error = computed(() => {
    for (const state of this._assets().values()) {
      if (state.error) return state.error;
    }
    return null;
  });
  readonly hasUnsavedChanges = computed(() => this._assets().size > 0);

  queued(assetId: AssetId): number {
    const revision = ++this._nextRevision;
    this._settledPhase.set('idle');
    this.set(assetId, { revision, phase: 'unsaved', error: null });
    return revision;
  }

  saving(assetId: AssetId, revision: number): void {
    if (!this.isCurrent(assetId, revision)) return;
    this.updatePhase(assetId, revision, 'saving');
  }

  saved(assetId: AssetId, revision: number): void {
    if (!this.isCurrent(assetId, revision)) return;
    this._assets.update((assets) => {
      const next = new Map(assets);
      next.delete(assetId);
      return next;
    });
    this._settledPhase.set('saved');
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
