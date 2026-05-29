// KeywordChipsRowComponent — spec.
//
// v0.1 is READ-ONLY. The spec verifies the existing chips render and the
// `+ Add` stub flow surfaces the "coming soon" hint. When the keyword-
// editing follow-up lands, these tests get expanded to cover the
// EditSession.setKeywords write path.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { KeywordChipsRowComponent } from './keyword-chips-row.component';
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

function setup(asset: Asset | null = ASSET_WITH_KEYWORDS) {
  TestBed.configureTestingModule({ imports: [KeywordChipsRowComponent] });
  const fixture = TestBed.createComponent(KeywordChipsRowComponent);
  fixture.componentRef.setInput('asset', asset);
  fixture.detectChanges();
  return fixture;
}

describe('KeywordChipsRowComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders each keyword as a chip', () => {
    const fixture = setup();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="info-keyword-travel"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="info-keyword-paris"]')).not.toBeNull();
  });

  it('always renders the + add chip', () => {
    const fixture = setup({ ...ASSET_WITH_KEYWORDS, keywords: [] });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="info-keyword-add"]')).not.toBeNull();
  });

  it('shows the v0.1 stub hint when + add is tapped', () => {
    const fixture = setup();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="info-keyword-stub"]')).toBeNull();

    (root.querySelector('[data-testid="info-keyword-add"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    const hint = root.querySelector('[data-testid="info-keyword-stub"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('coming soon');
  });

  it('dismisses the stub hint when OK is tapped', () => {
    const fixture = setup();
    const root = fixture.nativeElement as HTMLElement;
    (root.querySelector('[data-testid="info-keyword-add"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    (root.querySelector('[data-testid="info-keyword-stub"] .dismiss') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="info-keyword-stub"]')).toBeNull();
  });

  it('renders no keyword chips for an asset with empty keywords', () => {
    const fixture = setup({ ...ASSET_WITH_KEYWORDS, keywords: [] });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.chip:not(.chip-add)').length).toBe(0);
  });

  it('renders no keyword chips for a null asset', () => {
    const fixture = setup(null);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.chip:not(.chip-add)').length).toBe(0);
    // The + add chip still renders so the affordance is visible.
    expect(root.querySelector('[data-testid="info-keyword-add"]')).not.toBeNull();
  });
});
