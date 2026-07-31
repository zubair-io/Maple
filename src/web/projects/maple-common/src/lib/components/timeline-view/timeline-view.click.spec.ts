// Click semantics (#2404) — same contract as AssetGridComponent's
// onThumbClick so Folder and Timeline mode behave identically: a plain
// click selects and navigates to `/view/…`; Cmd/Ctrl-click and Shift-click
// each mutate the selection without navigating; while Select mode is on,
// every click toggles membership and never navigates.
//
// Split out of timeline-view.component.spec.ts so neither file grows past the
// changed-file LOC headroom gate; shared stubs live in
// ./timeline-view.test-helpers.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { TimelineViewComponent } from './timeline-view.component';
import { LibraryStateService } from '../../state/library-state.service';
import { SearchService } from '../../api/search.service';
import { FilesystemBrowseService } from '../../api/filesystem-browse.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { provideLibrarySource } from '../../addressing/library-source-provider';
import {
  FsBrowseStub,
  SearchStub,
  clearPrefKeys,
  installObserverStubs,
  makeResult,
} from './timeline-view.test-helpers';

beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

describe('TimelineViewComponent — click semantics (#2404)', () => {
  let library: LibraryStateService;
  let searchStub: SearchStub;

  beforeEach(() => {
    installObserverStubs();

    searchStub = new SearchStub();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLibrarySource,
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: searchStub },
        { provide: FilesystemBrowseService, useValue: new FsBrowseStub() },
      ],
    });
    library = TestBed.inject(LibraryStateService);
    library.registeredFolders.set([
      {
        id: 'lib-1',
        slug: 'lib',
        path: '/Lib',
        label: 'Lib',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    library.sidebarTree.set([
      { kind: 'folder', id: 'lib:', label: 'Lib', count: null, absPath: '/Lib' },
    ]);
  });

  async function renderOnePhoto() {
    searchStub.pages = [
      {
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    return fixture;
  }

  function tileEl(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.timeline-photo') as HTMLButtonElement;
  }

  it('a plain click selects and navigates to /view/…', async () => {
    const fixture = await renderOnePhoto();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    tileEl(fixture).click();
    fixture.detectChanges();

    expect(library.selectedAssetIds().has('a' as never)).toBe(true);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it('Cmd-click toggles selection and does not navigate', async () => {
    const fixture = await renderOnePhoto();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    tileEl(fixture).dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    fixture.detectChanges();

    expect(library.selectedAssetIds().has('a' as never)).toBe(true);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('Shift-click extends the range and does not navigate', async () => {
    const fixture = await renderOnePhoto();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    tileEl(fixture).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    fixture.detectChanges();

    expect(library.selectedAssetIds().has('a' as never)).toBe(true);
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('a click in Select mode toggles membership and does not navigate; selection survives leaving the mode', async () => {
    const fixture = await renderOnePhoto();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    library.toggleSelectMode();
    expect(library.isSelecting()).toBe(true);

    tileEl(fixture).click();
    fixture.detectChanges();

    expect(library.selectedAssetIds().has('a' as never)).toBe(true);
    expect(navigateSpy).not.toHaveBeenCalled();

    // Leaving the mode keeps whatever was selected.
    library.toggleSelectMode();
    expect(library.isSelecting()).toBe(false);
    expect(library.selectedAssetIds().has('a' as never)).toBe(true);
  });

  it('renders a check affordance on the tile only while Select mode is on, reflecting membership', async () => {
    const fixture = await renderOnePhoto();
    expect(fixture.nativeElement.querySelector('[data-testid="select-checkbox"]')).toBeNull();

    library.toggleSelectMode();
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('[data-testid="select-checkbox"]');
    expect(badge).not.toBeNull();
    expect(badge!.classList.contains('bg-primary')).toBe(false);

    tileEl(fixture).click();
    fixture.detectChanges();
    expect(badge!.classList.contains('bg-primary')).toBe(true);
  });
});
