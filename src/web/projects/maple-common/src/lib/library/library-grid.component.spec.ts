// library-grid.component.spec.ts — S2 (#623). Exercises grid render +
// cell-tap routing.
//
// Layout is CSS-only so the column count isn't asserted here — the
// CSS rules are exercised by the Playwright viewport-resize harness.
// The spec stays in jsdom land: stubs the data services so the
// component renders a deterministic asset list, then verifies that
// cell taps drive the router + selection service.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { LibraryGridComponent } from './library-grid.component';
import { Asset } from '../models/asset';
import { viewRouteCommands } from '../addressing/route-address';
import { BrowsePreferencesService, CullFilter } from '../state/browse-preferences.service';
import { LibrarySelection } from '../state/library-selection.service';
import { LibraryStateService } from '../state/library-state.service';

function mkAsset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    filename: `${id}.dng`,
    folderId: 'f',
    rating: 0,
    flag: 'unflagged',
    colorLabel: null,
    thumbnailGradient: 'data:image/svg+xml,<svg/>',
    aspectRatio: 1.5,
    ...over,
  };
}

describe('LibraryGridComponent', () => {
  let fixture: ComponentFixture<LibraryGridComponent>;
  let assets: ReturnType<typeof signal<Asset[]>>;
  let filter: ReturnType<typeof signal<CullFilter>>;
  let label: ReturnType<typeof signal<string>>;
  let selectCalls: string[];

  beforeEach(async () => {
    assets = signal<Asset[]>([mkAsset('a'), mkAsset('b'), mkAsset('c')]);
    filter = signal<CullFilter>('all');
    label = signal<string>('France trip');
    selectCalls = [];

    const stateStub = {
      thumbnailUrlFor: () => undefined,
      ensureThumbnailUrl: () => {},
      cancelQueuedThumbnail: () => {},
      // Mirror the real cache: invoke the callback synchronously (so the cell's
      // effect actually exercises the signal write — an empty stub would mask an
      // NG0600 on mount).
      subscribeThumbUrl: (_id: unknown, cb: (url: string | undefined) => void) => {
        cb(undefined);
        return () => {};
      },
    };
    const prefsStub = { filter };
    const selectionStub = {
      assetsInSelectedFolder: assets,
      selectedSourceLabel: label,
      selectAsset: (id: string) => {
        selectCalls.push(id);
      },
    };

    await TestBed.configureTestingModule({
      imports: [LibraryGridComponent],
      providers: [
        provideRouter([{ path: 'view/:id', children: [] }]),
        { provide: LibraryStateService, useValue: stateStub },
        { provide: BrowsePreferencesService, useValue: prefsStub },
        { provide: LibrarySelection, useValue: selectionStub },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LibraryGridComponent);
    fixture.detectChanges();
  });

  it('renders one cell per asset in the selected folder', () => {
    const cells = fixture.nativeElement.querySelectorAll('app-library-cell');
    expect(cells.length).toBe(3);
  });

  it('shows the source label as the page title', () => {
    const h1 = fixture.nativeElement.querySelector('h1.source-title') as HTMLElement;
    expect(h1.textContent?.trim()).toBe('France trip');
  });

  it('falls back to "Library" when the selection has no label', () => {
    label.set('');
    fixture.detectChanges();
    const h1 = fixture.nativeElement.querySelector('h1.source-title') as HTMLElement;
    expect(h1.textContent?.trim()).toBe('Library');
  });

  it('navigates to Preview (/view/:id) and selects on cell tap', async () => {
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const button = fixture.nativeElement.querySelector(
      'app-library-cell button.library-cell',
    ) as HTMLButtonElement;
    button.click();
    expect(selectCalls).toEqual(['a']);
    expect(navSpy).toHaveBeenCalledWith(viewRouteCommands('a'));
    expect(navSpy).toHaveBeenCalledWith(['/view', 'a']);
  });

  it('writes filter changes back to BrowsePreferencesService + localStorage', () => {
    // vitest's jsdom env (Angular CLI unit-test builder) ships an
    // empty `localStorage` placeholder — `globalThis.localStorage`
    // is a bare object with no `setItem`/`getItem` methods and no
    // `Storage` prototype attached. The component's `setItem` call
    // throws and is swallowed by its own try/catch, so a
    // `Storage.prototype.setItem` spy never fires (#649).
    //
    // Replace the placeholder with a minimal in-memory Storage stub
    // we can spy on directly. The previous value is restored in the
    // `finally` block so other specs see the original env.
    const store = new Map<string, string>();
    const stub = {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: stub,
    });
    try {
      const setItemSpy = vi.spyOn(stub, 'setItem');
      const filterChip = fixture.nativeElement.querySelectorAll(
        'button.chip',
      )[1] as HTMLButtonElement;
      filterChip.click();
      expect(filter()).toBe('picks');
      expect(setItemSpy).toHaveBeenCalledWith('cm.filter', '"picks"');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});
