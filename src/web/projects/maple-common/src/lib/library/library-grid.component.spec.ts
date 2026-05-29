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
        provideRouter([{ path: 'edit/:id', children: [] }]),
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

  it('navigates to /edit/:id and selects on cell tap', async () => {
    const router = TestBed.inject(Router);
    const navSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const button = fixture.nativeElement.querySelector(
      'app-library-cell button.library-cell',
    ) as HTMLButtonElement;
    button.click();
    expect(selectCalls).toEqual(['a']);
    expect(navSpy).toHaveBeenCalledWith(['/edit', 'a']);
  });

  it('writes filter changes back to BrowsePreferencesService + localStorage', () => {
    const filterChip = fixture.nativeElement.querySelectorAll(
      'button.chip',
    )[1] as HTMLButtonElement;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    filterChip.click();
    expect(filter()).toBe('picks');
    expect(setItemSpy).toHaveBeenCalledWith('cm.filter', '"picks"');
  });
});
