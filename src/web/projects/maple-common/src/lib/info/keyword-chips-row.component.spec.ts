// KeywordChipsRowComponent — spec.
//
// Covers (1) read-only chip rendering, (2) the `+ Add` inline-input
// flow, and (3) the remove-on-tap flow. Both write paths route through
// `LibraryStateService.setKeywords`; the spec injects a spy so the
// callsite is verified without exercising the real sidecar-store /
// FS Access plumbing. Sidecar-write integration is covered in
// `xmp/sidecar.store.spec.ts` (#632).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { KeywordChipsRowComponent } from './keyword-chips-row.component';
import { LibraryStateService } from '../state/library-state.service';
import type { Asset } from '../models/asset';

const ASSET_WITH_KEYWORDS: Asset = {
  id: 'a-1',
  filename: 'IMG.dng',
  folderId: 'f-1',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  keywords: ['travel', 'paris'],
};

interface LibraryStub {
  setKeywords: ReturnType<typeof vi.fn>;
}

function setup(asset: Asset | null = ASSET_WITH_KEYWORDS) {
  const libraryStub: LibraryStub = { setKeywords: vi.fn() };
  TestBed.configureTestingModule({
    imports: [KeywordChipsRowComponent],
    providers: [{ provide: LibraryStateService, useValue: libraryStub }],
  });
  const fixture = TestBed.createComponent(KeywordChipsRowComponent);
  fixture.componentRef.setInput('asset', asset);
  fixture.detectChanges();
  return { fixture, library: libraryStub };
}

describe('KeywordChipsRowComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders each keyword as a chip', () => {
    const { fixture } = setup();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="info-keyword-travel"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="info-keyword-paris"]')).not.toBeNull();
  });

  it('always renders the + add chip', () => {
    const { fixture } = setup({ ...ASSET_WITH_KEYWORDS, keywords: [] });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="info-keyword-add"]')).not.toBeNull();
  });

  it('replaces the + add chip with an inline input when tapped', () => {
    const { fixture } = setup();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="info-keyword-input"]')).toBeNull();

    (root.querySelector('[data-testid="info-keyword-add"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(root.querySelector('[data-testid="info-keyword-input"]')).not.toBeNull();
    // While editing, the dashed `+ Add` chip is hidden — the input
    // occupies its slot in the FlowLayout row.
    expect(root.querySelector('[data-testid="info-keyword-add"]')).toBeNull();
  });

  it('commits a new keyword via LibraryStateService.setKeywords on Enter', () => {
    const { fixture, library } = setup();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="info-keyword-add"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const input = root.querySelector('[data-testid="info-keyword-input"]') as HTMLInputElement;
    input.value = 'sunset';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(library.setKeywords).toHaveBeenCalledWith('a-1', ['travel', 'paris', 'sunset']);
    // Input collapses back into the `+ Add` chip after commit.
    expect(root.querySelector('[data-testid="info-keyword-add"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="info-keyword-input"]')).toBeNull();
  });

  it('cancels on Escape without calling setKeywords', () => {
    const { fixture, library } = setup();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="info-keyword-add"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const input = root.querySelector('[data-testid="info-keyword-input"]') as HTMLInputElement;
    input.value = 'sunset';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(library.setKeywords).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="info-keyword-add"]')).not.toBeNull();
  });

  it('does not call setKeywords for an empty commit', () => {
    const { fixture, library } = setup();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="info-keyword-add"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const input = root.querySelector('[data-testid="info-keyword-input"]') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(library.setKeywords).not.toHaveBeenCalled();
  });

  it('removes a keyword via setKeywords when a chip is clicked', () => {
    const { fixture, library } = setup();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="info-keyword-paris"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(library.setKeywords).toHaveBeenCalledWith('a-1', ['travel']);
  });

  it('renders no keyword chips for an asset with empty keywords', () => {
    const { fixture } = setup({ ...ASSET_WITH_KEYWORDS, keywords: [] });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.chip-remove').length).toBe(0);
  });

  it('renders no keyword chips for a null asset', () => {
    const { fixture } = setup(null);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.chip-remove').length).toBe(0);
    // The + add chip still renders so the affordance is visible.
    expect(root.querySelector('[data-testid="info-keyword-add"]')).not.toBeNull();
  });
});
