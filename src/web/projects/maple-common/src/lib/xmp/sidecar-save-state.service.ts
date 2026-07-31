import { Injectable, computed, signal } from '@angular/core';
import type { AssetId } from '../models/asset';

export type SidecarSavePhase = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

@Injectable({ providedIn: 'root' })
export class SidecarSaveStateService {
  private readonly _phase = signal<SidecarSavePhase>('idle');
  private readonly _assetId = signal<AssetId | null>(null);
  private readonly _error = signal<string | null>(null);
  private _revision = 0;

  readonly phase = this._phase.asReadonly();
  readonly assetId = this._assetId.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasUnsavedChanges = computed(() => {
    const phase = this._phase();
    return phase === 'unsaved' || phase === 'saving' || phase === 'error';
  });

  queued(assetId: AssetId): number {
    this._revision += 1;
    this._assetId.set(assetId);
    this._error.set(null);
    this._phase.set('unsaved');
    return this._revision;
  }

  saving(assetId: AssetId, revision: number): void {
    if (!this.isCurrent(assetId, revision)) return;
    this._assetId.set(assetId);
    this._phase.set('saving');
  }

  saved(assetId: AssetId, revision: number): void {
    if (!this.isCurrent(assetId, revision)) return;
    this._error.set(null);
    this._phase.set('saved');
  }

  failed(assetId: AssetId, revision: number, error: unknown): void {
    if (!this.isCurrent(assetId, revision)) return;
    this._assetId.set(assetId);
    this._error.set(error instanceof Error ? error.message : String(error));
    this._phase.set('error');
  }

  private isCurrent(assetId: AssetId, revision: number): boolean {
    return this._assetId() === assetId && this._revision === revision;
  }
}
