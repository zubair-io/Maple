// EditorSidecarStatusBadge — unit tests for slice 2 of #193.
//
// Strategy: stub `SidecarStore` with writable signals so each `status` branch
// of the template can be exercised deterministically. The store's own
// behaviour is covered by `sidecar.store.spec.ts`; here we only verify the
// canonical reactive consumer pattern (template discriminator, lifecycle
// wiring via `setActiveId`, hosted no-op, focused→API id resolution).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal, type Signal } from '@angular/core';

import { EditorSidecarStatusBadgeComponent } from './editor-sidecar-status-badge.component';
import { SidecarStore, type SidecarDoc } from '../../xmp/sidecar.store';
import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import type { StoreStatus } from '../../state/store';

const LOCAL_ID = 'local-asset-1';
const API_ID = 'api-asset-1';

class FakeSidecarStore {
  // Public signals so the test can pin any status branch directly.
  status = signal<StoreStatus>('idle');
  data = signal<SidecarDoc | undefined>(undefined);
  loading = signal(false);
  refreshing = signal(false);
  error = signal<Error | null>(null);

  // Capture what the consumer wires into `setActiveId` so the test can
  // assert the resolution path is reactive.
  activeIdSignal: Signal<string | undefined> | null = null;
  setActiveId = vi.fn((idSig: Signal<string | undefined>) => {
    this.activeIdSignal = idSig;
  });
  setActiveIdValue = vi.fn();
  invalidate = vi.fn();
  write = vi.fn();
}

class FakeLibraryStateService {
  focusedAssetId = signal<string | undefined>(undefined);
  backend: 'hosted' | 'self-hosted' = 'self-hosted';
}

class FakeLibraryStore {
  apiAssetIds = new Map<string, string>();
}

function makeFixture(opts: { backend?: 'hosted' | 'self-hosted' } = {}) {
  const fakeStore = new FakeSidecarStore();
  const fakeState = new FakeLibraryStateService();
  fakeState.backend = opts.backend ?? 'self-hosted';
  const fakeLibrary = new FakeLibraryStore();
  fakeLibrary.apiAssetIds.set(LOCAL_ID, API_ID);

  TestBed.configureTestingModule({
    imports: [EditorSidecarStatusBadgeComponent],
    providers: [
      { provide: SidecarStore, useValue: fakeStore },
      { provide: LibraryStateService, useValue: fakeState },
      { provide: LibraryStore, useValue: fakeLibrary },
      { provide: LIBRARY_BACKEND, useValue: opts.backend ?? 'self-hosted' },
    ],
  });

  const fixture = TestBed.createComponent(EditorSidecarStatusBadgeComponent);
  fixture.detectChanges();
  return { fixture, store: fakeStore, state: fakeState, library: fakeLibrary };
}

function findBadge(fixture: ReturnType<typeof TestBed.createComponent>): HTMLElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector(
    '[data-testid="sidecar-status-badge"]',
  );
}

describe('EditorSidecarStatusBadgeComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('wires setActiveId with a signal derived from focusedAssetId + apiAssetIds', () => {
    const { fixture, store, state } = makeFixture();

    expect(store.setActiveId).toHaveBeenCalledTimes(1);
    // The signal handed to the store should resolve to `undefined` until a
    // focused asset is set (no fan-out, no eager fetch).
    const sig = store.activeIdSignal!;
    expect(sig()).toBeUndefined();

    state.focusedAssetId.set(LOCAL_ID);
    fixture.detectChanges();
    expect(sig()).toBe(API_ID);
  });

  it('renders nothing in idle state', () => {
    const { fixture, store } = makeFixture();
    store.status.set('idle');
    fixture.detectChanges();

    expect(findBadge(fixture)).toBeNull();
  });

  it('renders a loading chip when status=loading', () => {
    const { fixture, store } = makeFixture();
    store.status.set('loading');
    fixture.detectChanges();

    const badge = findBadge(fixture);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('data-status')).toBe('loading');
    expect(badge!.textContent).toContain('Loading sidecar');
    expect(badge!.querySelector('.spinner')).not.toBeNull();
  });

  it('renders a refreshing chip when status=refreshing', () => {
    const { fixture, store } = makeFixture();
    store.status.set('refreshing');
    fixture.detectChanges();

    const badge = findBadge(fixture);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('data-status')).toBe('refreshing');
    expect(badge!.textContent).toContain('Refreshing sidecar');
  });

  it('renders "No sidecar" when status=not-found', () => {
    const { fixture, store } = makeFixture();
    store.status.set('not-found');
    fixture.detectChanges();

    const badge = findBadge(fixture);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('data-status')).toBe('not-found');
    expect(badge!.textContent).toContain('No sidecar');
  });

  it('renders "Sidecar" plus rating stars when status=loaded with a rating', () => {
    const { fixture, store } = makeFixture();
    store.status.set('loaded');
    store.data.set({
      id: LOCAL_ID,
      model: {},
      culling: { rating: 3, flag: 'unflagged', colorLabel: null },
      passthrough: { unknownAttributes: [], unknownNodes: [] },
      xml: '<xml/>',
    } as SidecarDoc);
    fixture.detectChanges();

    const badge = findBadge(fixture);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('data-status')).toBe('loaded');
    expect(badge!.textContent).toContain('Sidecar');
    // 3 stars in the rating sub-span.
    expect(badge!.querySelector('.rating')?.textContent).toContain('★★★');
  });

  it('renders "Sidecar" without stars when loaded but rating is 0', () => {
    const { fixture, store } = makeFixture();
    store.status.set('loaded');
    store.data.set({
      id: LOCAL_ID,
      model: {},
      culling: { rating: 0, flag: 'unflagged', colorLabel: null },
      passthrough: { unknownAttributes: [], unknownNodes: [] },
      xml: '<xml/>',
    } as SidecarDoc);
    fixture.detectChanges();

    const badge = findBadge(fixture);
    expect(badge).not.toBeNull();
    expect(badge!.querySelector('.rating')).toBeNull();
  });

  it('renders an inline error chip when status=error', () => {
    const { fixture, store } = makeFixture();
    store.status.set('error');
    store.error.set(new Error('boom'));
    fixture.detectChanges();

    const badge = findBadge(fixture);
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute('data-status')).toBe('error');
    expect(badge!.textContent).toContain('Error: boom');
  });

  it('renders nothing in Hosted mode regardless of store status', () => {
    const { fixture, store } = makeFixture({ backend: 'hosted' });
    store.status.set('loaded');
    store.data.set({
      id: LOCAL_ID,
      model: {},
      culling: { rating: 5, flag: 'unflagged', colorLabel: null },
      passthrough: { unknownAttributes: [], unknownNodes: [] },
      xml: '<xml/>',
    } as SidecarDoc);
    fixture.detectChanges();

    expect(findBadge(fixture)).toBeNull();
  });

  it('resolved id stays undefined on Hosted even when focused asset is set', () => {
    // Hosted-mode wiring must not produce an API id — the store would
    // request the wrong URL if we did.
    const { fixture, store, state } = makeFixture({ backend: 'hosted' });
    state.focusedAssetId.set(LOCAL_ID);
    fixture.detectChanges();
    expect(store.activeIdSignal!()).toBeUndefined();
  });

  it('resolved id is undefined when focused asset has no API mapping', () => {
    const { fixture, store, state, library } = makeFixture();
    library.apiAssetIds.clear();
    state.focusedAssetId.set('orphan-id');
    fixture.detectChanges();
    expect(store.activeIdSignal!()).toBeUndefined();
  });

  it('re-resolves when focused asset id changes', () => {
    const { fixture, store, state, library } = makeFixture();
    library.apiAssetIds.set('local-2', 'api-2');

    state.focusedAssetId.set(LOCAL_ID);
    fixture.detectChanges();
    expect(store.activeIdSignal!()).toBe(API_ID);

    state.focusedAssetId.set('local-2');
    fixture.detectChanges();
    expect(store.activeIdSignal!()).toBe('api-2');

    state.focusedAssetId.set(undefined);
    fixture.detectChanges();
    expect(store.activeIdSignal!()).toBeUndefined();
  });

});
