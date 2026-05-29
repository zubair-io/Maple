// RatingFlagsRowComponent — spec.
//
// Verifies pill / star clicks route through LibraryStateService.setFlag /
// setRating with the right toggle semantics. The service itself is faked
// — its real behaviour is covered by library-state.service tests.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';

import { RatingFlagsRowComponent } from './rating-flags-row.component';
import { LibraryStateService } from '../state/library-state.service';
import type { Asset } from '../models/asset';

const BASE_ASSET: Asset = {
  id: 'asset-1',
  filename: 'IMG.dng',
  folderId: 'folder-1',
  rating: 2,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
};

class FakeLibraryStateService {
  setFlag = vi.fn();
  setRating = vi.fn();
  focusedAssetId = signal<string | undefined>(undefined);
}

function setup(asset: Asset | null = BASE_ASSET) {
  const state = new FakeLibraryStateService();
  TestBed.configureTestingModule({
    imports: [RatingFlagsRowComponent],
    providers: [{ provide: LibraryStateService, useValue: state }],
  });
  const fixture = TestBed.createComponent(RatingFlagsRowComponent);
  fixture.componentRef.setInput('asset', asset);
  fixture.detectChanges();
  return { fixture, state };
}

function click(fixture: ReturnType<typeof TestBed.createComponent>, testId: string) {
  const btn = (fixture.nativeElement as HTMLElement).querySelector(
    `[data-testid="${testId}"]`,
  ) as HTMLButtonElement;
  btn.click();
}

describe('RatingFlagsRowComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('tap pick pill calls setFlag(id, "pick") when flag was unflagged', () => {
    const { fixture, state } = setup();
    click(fixture, 'info-flag-pick');
    expect(state.setFlag).toHaveBeenCalledWith('asset-1', 'pick');
  });

  it('tap currently-active flag is a no-op (no state call)', () => {
    const { fixture, state } = setup({ ...BASE_ASSET, flag: 'pick' });
    click(fixture, 'info-flag-pick');
    expect(state.setFlag).not.toHaveBeenCalled();
  });

  it('tap reject pill calls setFlag(id, "reject")', () => {
    const { fixture, state } = setup();
    click(fixture, 'info-flag-reject');
    expect(state.setFlag).toHaveBeenCalledWith('asset-1', 'reject');
  });

  it('tap a new star sets the rating', () => {
    const { fixture, state } = setup(); // rating = 2
    click(fixture, 'info-star-4');
    expect(state.setRating).toHaveBeenCalledWith('asset-1', 4);
  });

  it('tap currently-selected star clears the rating (Lightroom toggle)', () => {
    const { fixture, state } = setup({ ...BASE_ASSET, rating: 3 });
    click(fixture, 'info-star-3');
    expect(state.setRating).toHaveBeenCalledWith('asset-1', 0);
  });

  it('disables interaction when asset is null', () => {
    const { fixture, state } = setup(null);
    click(fixture, 'info-flag-pick');
    click(fixture, 'info-star-3');
    expect(state.setFlag).not.toHaveBeenCalled();
    expect(state.setRating).not.toHaveBeenCalled();
  });

  it('renders filled-star variant for indices ≤ rating', () => {
    const { fixture } = setup({ ...BASE_ASSET, rating: 3 });
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="info-star-1"]')?.classList.contains('filled')).toBe(
      true,
    );
    expect(root.querySelector('[data-testid="info-star-3"]')?.classList.contains('filled')).toBe(
      true,
    );
    expect(root.querySelector('[data-testid="info-star-4"]')?.classList.contains('filled')).toBe(
      false,
    );
  });
});
