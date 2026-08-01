import { signal } from '@angular/core';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutService, type MapleLayout } from '../../layout-service';
import { LibraryStateService } from '../../state/library-state.service';
import { STORAGE_KEYS } from '../../util/typed-storage';
import { provideHostedWorkspace } from '../../workspace/hosted-workspace.providers';
import { BrowseShellComponent } from './browse-shell.component';

function clearPreferences(): void {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
}

describe('BrowseShellComponent capability boundary', () => {
  let http: HttpTestingController;
  let layout: ReturnType<typeof signal<MapleLayout>>;
  let originalResizeObserver: unknown;
  let originalIntersectionObserver: unknown;

  beforeEach(() => {
    clearPreferences();
    const globals = globalThis as {
      ResizeObserver?: unknown;
      IntersectionObserver?: unknown;
    };
    originalResizeObserver = globals.ResizeObserver;
    originalIntersectionObserver = globals.IntersectionObserver;
    const observer = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    globals.ResizeObserver = observer;
    globals.IntersectionObserver = observer;
    layout = signal<MapleLayout>('desktop');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideHostedWorkspace(),
        { provide: LayoutService, useValue: { layout } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      http.verify();
    } finally {
      const globals = globalThis as {
        ResizeObserver?: unknown;
        IntersectionObserver?: unknown;
      };
      globals.ResizeObserver = originalResizeObserver;
      globals.IntersectionObserver = originalIntersectionObserver;
      clearPreferences();
    }
  });

  it('renders only browser-backed Browse composition by default', () => {
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('app-drop-zone')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-asset-grid')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="View mode"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Edit metadata"]')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Merge to panorama');
    expect(http.match(() => true)).toEqual([]);
  });

  it('switches from the inline sidebar to the source drawer at phone width', () => {
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="source-drawer-toggle"]')).toBeNull();

    layout.set('tablet');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).not.toBeNull();

    layout.set('phone');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="source-sidebar"]')).toBeNull();
    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="source-drawer-toggle"]',
    ) as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.sourceDrawerOpen()).toBe(true);
    expect(
      fixture.nativeElement.querySelector('[data-testid="source-picker-drawer"]'),
    ).not.toBeNull();
  });

  it('routes plain and addressed drawer selections through shared source selection', () => {
    layout.set('phone');
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();
    const state = TestBed.inject(LibraryStateService);
    const openSubfolder = vi.spyOn(state, 'openSelfHostedSubfolder');
    const setFolderOpen = vi.spyOn(state, 'setFolderOpen');

    fixture.componentInstance.onDrawerSourceSelected('legacy-root');
    expect(state.selectedSourceId()).toBe('legacy-root');
    expect(openSubfolder).not.toHaveBeenCalled();

    fixture.componentInstance.onDrawerSourceSelected('library:2026/trip');
    expect(openSubfolder).toHaveBeenCalledWith('2026/trip', 'library:2026/trip');
    expect(setFolderOpen).toHaveBeenCalledWith('library:2026/trip', true);
  });

  it('keeps shared select-mode keyboard behavior', () => {
    const fixture = TestBed.createComponent(BrowseShellComponent);
    fixture.detectChanges();
    const state = fixture.componentInstance.state;
    const select = fixture.nativeElement.querySelector(
      '[aria-label="Select"]',
    ) as HTMLButtonElement;
    select.click();
    state.selectAsset('asset-1' as never);

    expect(state.isSelecting()).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(state.isSelecting()).toBe(false);
    expect(state.selectedAssetIds().has('asset-1' as never)).toBe(true);
  });
});
