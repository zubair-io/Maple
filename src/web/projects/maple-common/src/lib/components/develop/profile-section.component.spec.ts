// ProfileSectionComponent — unit tests (Auto Profile UI, ticket #567).
//
// Strategy: stub `LibraryStateService` with a writable signal so the active
// adjustment can be flipped between `Auto` and `Neutral`, then assert that
// the two-button toggle renders, click-dispatches a Partial<AdjustmentModel>
// to `updateAdjustment`, and reflects the active branch in the `.active`
// class.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';

import { ProfileSectionComponent } from './profile-section.component';
import { LibraryStateService } from '../../state/library-state.service';
import {
  defaultAdjustmentModel,
  type AdjustmentModel,
} from '../../models/adjustment-model';

const ASSET_ID = 'local-asset-1';

class FakeLibraryStateService {
  focusedAssetId = signal<string | undefined>(ASSET_ID);
  private adj = signal<AdjustmentModel>({ ...defaultAdjustmentModel(), profile: 'Auto' });
  adjustmentFor = vi.fn(() => this.adj);
  updateAdjustment = vi.fn((_id: string, patch: Partial<AdjustmentModel>) => {
    this.adj.update((m) => ({ ...m, ...patch }));
  });
}

function makeFixture() {
  const state = new FakeLibraryStateService();
  TestBed.configureTestingModule({
    imports: [ProfileSectionComponent],
    providers: [{ provide: LibraryStateService, useValue: state }],
  });
  const fixture = TestBed.createComponent(ProfileSectionComponent);
  fixture.detectChanges();
  return { fixture, state };
}

function buttons(fixture: ReturnType<typeof TestBed.createComponent>): HTMLButtonElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '.profile-button',
    ),
  );
}

describe('ProfileSectionComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders both Auto and Neutral buttons', () => {
    const { fixture } = makeFixture();
    const labels = buttons(fixture).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Auto', 'Neutral']);
  });

  it('clicking Neutral calls updateAdjustment with { profile: "Neutral" }', () => {
    const { fixture, state } = makeFixture();
    const [, neutral] = buttons(fixture);
    neutral.click();
    fixture.detectChanges();

    expect(state.updateAdjustment).toHaveBeenCalledTimes(1);
    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { profile: 'Neutral' });
  });

  it('clicking Auto calls updateAdjustment with { profile: "Auto" }', () => {
    const { fixture, state } = makeFixture();
    // First flip to Neutral so the Auto click is a real change.
    buttons(fixture)[1].click();
    state.updateAdjustment.mockClear();
    fixture.detectChanges();

    buttons(fixture)[0].click();
    fixture.detectChanges();

    expect(state.updateAdjustment).toHaveBeenCalledTimes(1);
    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { profile: 'Auto' });
  });

  it('active button reflects the current adjustment profile', () => {
    const { fixture, state } = makeFixture();
    let [auto, neutral] = buttons(fixture);
    expect(auto.classList.contains('active')).toBe(true);
    expect(neutral.classList.contains('active')).toBe(false);
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(neutral.getAttribute('aria-pressed')).toBe('false');

    neutral.click();
    fixture.detectChanges();
    [auto, neutral] = buttons(fixture);
    expect(auto.classList.contains('active')).toBe(false);
    expect(neutral.classList.contains('active')).toBe(true);
    expect(auto.getAttribute('aria-pressed')).toBe('false');
    expect(neutral.getAttribute('aria-pressed')).toBe('true');
    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { profile: 'Neutral' });
  });

  it('renders nothing when no asset is focused', () => {
    const { fixture, state } = makeFixture();
    state.focusedAssetId.set(undefined);
    fixture.detectChanges();
    expect(buttons(fixture)).toEqual([]);
  });
});
