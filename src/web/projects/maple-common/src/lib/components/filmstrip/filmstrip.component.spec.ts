// filmstrip.component.spec.ts — guards select()'s route-mode branch
// (#Web Preview Surface Task 6a): default 'edit' mode must be unchanged
// (existing EditorShellComponent rail), and the new 'view' mode must route
// into Preview instead, for PreviewShellComponent's embedded filmstrip.

import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';

import { FilmstripComponent } from './filmstrip.component';
import { LibraryStateService } from '../../state/library-state.service';
import { editRouteCommands, viewRouteCommands } from '../../addressing/route-address';
import type { Asset } from '../../models/asset';

const ASSET: Asset = {
  id: 'library:2026/a.jpg',
  filename: '2026/a.jpg',
  folderId: 'folder-1',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

function setup() {
  const navigate = vi.fn();
  const selectAsset = vi.fn();
  const state = {
    assetsInSelectedFolder: () => [ASSET],
    focusedAssetId: signal<string | null>(ASSET.id),
    selectAsset,
    ensureThumbnailUrl: vi.fn(),
    cancelQueuedThumbnail: vi.fn(),
    subscribeThumbUrl: vi.fn(() => () => {}),
    isSelecting: () => false,
  };

  TestBed.configureTestingModule({
    imports: [FilmstripComponent],
    providers: [
      { provide: LibraryStateService, useValue: state },
      { provide: Router, useValue: { navigate } },
    ],
  });

  const fixture = TestBed.createComponent(FilmstripComponent);
  fixture.detectChanges();
  return { fixture, navigate, selectAsset };
}

describe('FilmstripComponent', () => {
  it('defaults routeMode to "edit"', () => {
    const { fixture } = setup();
    expect(fixture.componentInstance.routeMode()).toBe('edit');
  });

  it('select() navigates via editRouteCommands in the default "edit" mode', () => {
    const { fixture, navigate, selectAsset } = setup();
    fixture.componentInstance.select(ASSET);
    expect(selectAsset).toHaveBeenCalledWith(ASSET.id);
    expect(navigate).toHaveBeenCalledWith(editRouteCommands(ASSET.id));
  });

  it('select() navigates via viewRouteCommands when routeMode is "view"', () => {
    const { fixture, navigate, selectAsset } = setup();
    fixture.componentRef.setInput('routeMode', 'view');
    fixture.detectChanges();
    fixture.componentInstance.select(ASSET);
    expect(selectAsset).toHaveBeenCalledWith(ASSET.id);
    expect(navigate).toHaveBeenCalledWith(viewRouteCommands(ASSET.id));
  });

  it("a rendered thumb's thumbClick output invokes select() with the configured routeMode", () => {
    const { fixture, navigate } = setup();
    fixture.componentRef.setInput('routeMode', 'view');
    fixture.detectChanges();
    const selectSpy = vi.spyOn(fixture.componentInstance, 'select');
    const el = fixture.nativeElement as HTMLElement;
    // `.thumb` (inside <maple-asset-thumb>'s own template) owns the
    // `(click)="thumbClick.emit($event)"` handler — the outer `[data-id]`
    // wrapper div added by the filmstrip template has no listener itself.
    const thumb = el.querySelector('[data-id] .thumb') as HTMLElement;
    thumb.click();
    expect(selectSpy).toHaveBeenCalledWith(ASSET);
    expect(navigate).toHaveBeenCalledWith(viewRouteCommands(ASSET.id));
  });

  it('expanded: the header reads FILM with a Hide toggle', () => {
    const { fixture } = setup();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.strip-title span')?.textContent).toBe('FILM');
    const toggle = el.querySelector('.strip-title .strip-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide filmstrip');
    expect(el.querySelector('.strip-scroll')).not.toBeNull();
    expect(el.querySelector('[data-testid="film-tab"]')).toBeNull();
  });

  it('collapsed: the strip shrinks to a vertical FILM tab with a Show toggle', () => {
    const { fixture } = setup();
    fixture.componentInstance.toggleCollapsed();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.strip-scroll')).toBeNull();
    expect(el.querySelector('.strip-title')).toBeNull();
    const tab = el.querySelector('[data-testid="film-tab"]') as HTMLButtonElement;
    expect(tab).not.toBeNull();
    expect(tab.textContent).toContain('FILM');
    expect(tab.getAttribute('aria-expanded')).toBe('false');
    expect(tab.getAttribute('aria-label')).toBe('Show filmstrip');
  });

  it('toggleCollapsed() emits collapsedChange so host rails can shrink', () => {
    const { fixture } = setup();
    const emitted: boolean[] = [];
    fixture.componentInstance.collapsedChange.subscribe((v: boolean) => emitted.push(v));
    fixture.componentInstance.toggleCollapsed();
    fixture.componentInstance.toggleCollapsed();
    expect(emitted).toEqual([true, false]);
  });

  it('clicking the collapsed tab expands the strip', () => {
    const { fixture } = setup();
    fixture.componentInstance.toggleCollapsed();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="film-tab"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.collapsed()).toBe(false);
    expect(el.querySelector('.strip-scroll')).not.toBeNull();
  });
});
