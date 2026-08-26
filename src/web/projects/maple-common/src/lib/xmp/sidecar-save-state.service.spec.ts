// sidecar-save-state.service.spec.ts — revision-tracking + the
// `statusText` presentation mapping (MW2, #3029). Ported from the deleted
// `SaveStatusComponent`'s spec: that component was a thin `@if` shell over
// this service's `phase()`/`error()`; the DOM-shaped assertions below now
// exercise `statusText` directly (`root-shell`/`hosted-root-shell` just
// bind it into `<mui-status-text>`), and the revision-race tests move over
// unchanged since they were already pure service-state assertions with no
// DOM in them.

import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SidecarSaveStateService } from './sidecar-save-state.service';

describe('SidecarSaveStateService', () => {
  function make(): SidecarSaveStateService {
    TestBed.configureTestingModule({});
    return TestBed.inject(SidecarSaveStateService);
  }

  it('is silent (statusText null) at rest', () => {
    const state = make();
    expect(state.statusText()).toBeNull();
  });

  it('reports "Saving edits…" while a sidecar is queued', () => {
    const state = make();
    state.queued('asset-1');
    expect(state.statusText()).toEqual({ state: 'saving', text: 'Saving edits…' });
  });

  it('reports "Saving edits…" while a sidecar write is in flight', () => {
    const state = make();
    const revision = state.queued('asset-1');
    state.saving('asset-1', revision);
    expect(state.statusText()).toEqual({ state: 'saving', text: 'Saving edits…' });
  });

  it('goes silent again once the write settles', () => {
    const state = make();
    const revision = state.queued('asset-1');
    state.saved('asset-1', revision);
    expect(state.statusText()).toBeNull();
    expect(state.phase()).toBe('saved');
  });

  it('reports a persistent error including the failure message', () => {
    const state = make();
    const revision = state.queued('asset-1');
    state.failed('asset-1', revision, new Error('Permission denied'));
    expect(state.statusText()).toEqual({
      state: 'error',
      text: 'Edits are not saved. Permission denied',
    });
  });

  it('ignores completion from an older write revision', () => {
    const state = make();
    const stale = state.queued('asset-1');
    state.saving('asset-1', stale);
    state.queued('asset-1');
    state.saved('asset-1', stale);

    expect(state.phase()).toBe('unsaved');
  });

  it('clears an older failure after a later retry succeeds', () => {
    const state = make();
    const failed = state.queued('asset-1');
    state.failed('asset-1', failed, new Error('Permission denied'));
    const retry = state.queued('asset-1');
    state.saving('asset-1', retry);
    state.saved('asset-1', retry);

    expect(state.phase()).toBe('saved');
    expect(state.error()).toBeNull();
    expect(state.hasUnsavedChanges()).toBe(false);
  });

  it('keeps a newer failure visible when an older write finishes', () => {
    const state = make();
    const stale = state.queued('asset-1');
    const current = state.queued('asset-1');
    state.failed('asset-1', current, new Error('Disk full'));

    state.saved('asset-1', stale);

    expect(state.phase()).toBe('error');
    expect(state.error()).toBe('Disk full');
  });

  it('keeps a failure visible when a different asset saves later', () => {
    const state = make();
    const failed = state.queued('asset-1');
    const saved = state.queued('asset-2');
    state.failed('asset-1', failed, new Error('Disk full'));
    state.saved('asset-2', saved);

    expect(state.phase()).toBe('error');
    expect(state.error()).toBe('Disk full');
    expect(state.hasUnsavedChanges()).toBe(true);
  });
});
