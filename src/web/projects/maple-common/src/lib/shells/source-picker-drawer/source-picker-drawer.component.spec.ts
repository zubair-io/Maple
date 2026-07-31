// SourcePickerDrawerComponent — event-emission + visibility tests.
//
// Pan-to-dismiss is verified by a Playwright e2e at
// `src/web/e2e/source-picker-drawer.spec.ts` instead of in jsdom — jsdom
// doesn't dispatch PointerEvents the way a real browser does (pointer
// capture + clientWidth round-trips), so a unit test would test the test
// rather than the component.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { Component, signal } from '@angular/core';

import { SourcePickerDrawerComponent } from './source-picker-drawer.component';
import { SidebarEntry } from '../../models/folder';

/** Sample tree mirroring HTML frame 01 — three sections (FOLDERS / PHOTOS
 * LIBRARY / ALBUMS) with one selectable row each. The drawer doesn't own
 * tree-expansion state so a flat list is the simplest test fixture. */
const TREE: SidebarEntry[] = [
  { kind: 'section', id: 'sec-folders', label: 'FOLDERS', count: null },
  { kind: 'folder', id: 'fs:/Photos/Trip', label: 'Trip 2026', count: 42 },
  { kind: 'section', id: 'sec-photos', label: 'PHOTOS LIBRARY', count: null },
  { kind: 'smart', id: 'smart:all', label: 'All Photos', count: 12481 },
  { kind: 'section', id: 'sec-albums', label: 'ALBUMS', count: null },
  { kind: 'album', id: 'album:fam', label: 'Family', count: 312 },
];

// A test host lets us bind `isOpen` two-way to a parent signal so we can
// observe the model() output without subscribing manually.
@Component({
  standalone: true,
  imports: [SourcePickerDrawerComponent],
  template: `
    <app-source-picker-drawer
      [(isOpen)]="open"
      [sourceTree]="tree"
      [connectionIdentity]="identity"
      [tertiarySummary]="tertiary"
      [showSearch]="showSearch()"
      (sourceSelected)="picked.set($event)"
      (searchPillTap)="searchTapped.update((v) => v + 1)"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly tree = TREE;
  readonly identity = 'maple.lawrence.io';
  readonly tertiary = '12,481 photos · synced 2m ago';
  readonly showSearch = signal(true);
  readonly picked = signal<string | null>(null);
  readonly searchTapped = signal(0);
}

describe('SourcePickerDrawerComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders nothing when isOpen is false', () => {
    host.open.set(false);
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="source-picker-drawer"]')).toBeNull();
    expect(el().querySelector('.scrim')).toBeNull();
  });

  it('renders scrim, drawer chrome, and source tree when open', () => {
    expect(el().querySelector('.scrim')).not.toBeNull();
    const drawer = el().querySelector('[data-testid="source-picker-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute('aria-modal')).toBe('true');
    expect(el().querySelector('.eyebrow')?.textContent).toBe('LIBRARY');
    expect(el().querySelector('.identity')?.textContent).toBe('maple.lawrence.io');
    expect(el().querySelector('.tertiary')?.textContent).toContain('12,481 photos');
    // Three section headers from the tree fixture, each rendered as <h3>.
    expect(el().querySelectorAll('.section-header').length).toBe(3);
    // Three selectable rows (one per section in the fixture).
    expect(el().querySelectorAll('.source-row').length).toBe(3);
  });

  it('emits sourceSelected and closes itself when a source row is tapped', () => {
    const row = el().querySelector('[data-testid="source-row-smart:all"]') as HTMLButtonElement;
    expect(row).not.toBeNull();
    row.click();
    fixture.detectChanges();
    expect(host.picked()).toBe('smart:all');
    expect(host.open()).toBe(false);
  });

  it('does NOT emit sourceSelected when a section header is tapped', () => {
    // Section headers render as <h3>, which has no click handler — but to
    // be explicit, exercise the no-op branch by clicking a synthetic row
    // of kind 'section'. (The template guards prevent rendering them as
    // buttons, so this is enforced statically too.)
    const headers = el().querySelectorAll('.section-header');
    (headers[0] as HTMLElement).click();
    fixture.detectChanges();
    expect(host.picked()).toBeNull();
    expect(host.open()).toBe(true);
  });

  it('emits searchPillTap and closes itself when the search pill is tapped', () => {
    const pill = el().querySelector(
      '[data-testid="source-picker-drawer-search-pill"]',
    ) as HTMLButtonElement;
    expect(pill).not.toBeNull();
    pill.click();
    fixture.detectChanges();
    expect(host.searchTapped()).toBe(1);
    expect(host.open()).toBe(false);
  });

  it('does not render search when the host has no search capability', () => {
    host.showSearch.set(false);
    fixture.detectChanges();

    const search = el().querySelector<HTMLButtonElement>(
      '[data-testid="source-picker-drawer-search-pill"]',
    );
    expect(search?.hidden).toBe(true);
  });

  it('closes when the scrim is clicked', () => {
    (el().querySelector('.scrim') as HTMLElement).click();
    fixture.detectChanges();
    expect(host.open()).toBe(false);
  });

  it('closes when the close button is tapped', () => {
    (el().querySelector('[data-testid="source-picker-drawer-close"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(host.open()).toBe(false);
  });

  it('hides the identity row when connectionIdentity is empty', () => {
    @Component({
      standalone: true,
      imports: [SourcePickerDrawerComponent],
      template: `
        <app-source-picker-drawer
          [(isOpen)]="open"
          [sourceTree]="tree"
          [connectionIdentity]="''"
          [tertiarySummary]="''"
        />
      `,
    })
    class EmptyHost {
      readonly open = signal(true);
      readonly tree = TREE;
    }
    const f = TestBed.createComponent(EmptyHost);
    f.detectChanges();
    const e = f.nativeElement as HTMLElement;
    expect(e.querySelector('.identity-row')).toBeNull();
    expect(e.querySelector('.tertiary')).toBeNull();
  });
});
