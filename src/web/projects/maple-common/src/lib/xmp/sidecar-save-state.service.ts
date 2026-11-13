import { Injectable, computed, signal } from '@angular/core';
import type { AssetId } from '../models/asset';
import type { MuiStatusTextState } from '../ui/status-text/mui-status-text.component';

export type SidecarSavePhase = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';

interface AssetSaveState {
  revision: number;
  phase: SidecarSavePhase;
  error: string | null;
}

function httpSaveFailureMessage(status: number): string {
  if (status === 0) return 'Check your connection and try again.';
  if (status >= 502 && status <= 504) return 'Check your connection to the server and try again.';
  if (status === 401 || status === 403) return 'Check your access to this folder and try again.';
  if (status >= 500) return 'Check folder permissions or available storage, then try again.';
  return 'Please try again.';
}

function responseStatus(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function responseMessage(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : null;
}

function saveFailureMessage(error: unknown): string {
  const status = responseStatus(error);
  if (status !== null) return httpSaveFailureMessage(status);
  if (error instanceof Error) return error.message || 'Please try again.';
  if (typeof error === 'string') return error.trim() || 'Please try again.';
  return responseMessage(error) ?? 'Please try again.';
}

/** What `<mui-status-text>` should show for a given phase, or `null` to
 * render nothing — `root-shell`/`hosted-root-shell`'s `maple-save-status`
 * mount only ever surfaced unsaved/saving work and hard failures; a
 * settled `idle`/`saved` phase was always silent (MW2, #3029: replaces
 * `SaveStatusComponent`'s own `@if` branches). */
export interface SidecarSaveStatusText {
  readonly state: MuiStatusTextState;
  readonly text: string;
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

  readonly statusText = computed<SidecarSaveStatusText | null>(() => {
    const phase = this.phase();
    if (phase === 'unsaved' || phase === 'saving') {
      return { state: 'saving', text: 'Saving edits…' };
    }
    if (phase === 'error') {
      return { state: 'error', text: `Edits are not saved. ${this.error() ?? ''}`.trimEnd() };
    }
    return null;
  });

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
      error: saveFailureMessage(error),
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
