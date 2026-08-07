// FilmPanelComponent — unit tests (epic #2683, Task 12).
//
// Strategy mirrors `profile-section.component.spec.ts`: stub
// `LibraryStateService` with a writable signal so the active `filmLook` /
// `filmStrength` can be flipped, then assert the 6 category groups render
// from `FILM_CATALOG`, a None row exists, selection dispatches
// `updateAdjustment({ filmLook })`, and the strength slider only shows (and
// dispatches `{ filmStrength }`) once a look is active.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';

import { FilmPanelComponent } from './film-panel.component';
import { LibraryStateService } from '../../state/library-state.service';
import { FILM_CATALOG } from '../../generated/film-catalog.generated';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

const ASSET_ID = 'local-asset-1';

class FakeLibraryStateService {
  focusedAssetId = signal<string | undefined>(ASSET_ID);
  private adj = signal<AdjustmentModel>({ ...defaultAdjustmentModel() });
  adjustmentFor = vi.fn(() => this.adj);
  updateAdjustment = vi.fn((_id: string, patch: Partial<AdjustmentModel>) => {
    this.adj.update((m) => ({ ...m, ...patch }));
  });
}

function makeFixture() {
  const state = new FakeLibraryStateService();
  TestBed.configureTestingModule({
    imports: [FilmPanelComponent],
    providers: [{ provide: LibraryStateService, useValue: state }],
  });
  const fixture = TestBed.createComponent(FilmPanelComponent);
  fixture.detectChanges();
  return { fixture, state };
}

function el(fixture: ReturnType<typeof TestBed.createComponent>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function lookButtons(fixture: ReturnType<typeof TestBed.createComponent>): HTMLButtonElement[] {
  return Array.from(el(fixture).querySelectorAll<HTMLButtonElement>('.film-look-row'));
}

describe('FilmPanelComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders a None row plus a row for every FILM_CATALOG entry, grouped into 6 categories', () => {
    const { fixture } = makeFixture();
    const rows = lookButtons(fixture);
    // +1 for the always-present None row.
    expect(rows.length).toBe(FILM_CATALOG.length + 1);
    expect(rows[0].textContent?.trim()).toBe('None');

    const categoryLabels = Array.from(el(fixture).querySelectorAll('.film-category-label')).map(
      (n) => n.textContent?.trim(),
    );
    expect(categoryLabels.length).toBe(6);
    expect(new Set(categoryLabels).size).toBe(6);
  });

  it('None is active and the strength slider is hidden on a pristine default model', () => {
    const { fixture } = makeFixture();
    const none = lookButtons(fixture)[0];
    expect(none.classList.contains('film-look-row--active')).toBe(true);
    expect(el(fixture).querySelector('[data-testid="film-strength-row"]')).toBeNull();
  });

  it('clicking a look calls updateAdjustment with { filmLook } and reveals the strength slider', () => {
    const { fixture, state } = makeFixture();
    const target = FILM_CATALOG.find((e) => e.id === 'slide_fuji_velvia_50') ?? FILM_CATALOG[0];
    const row = lookButtons(fixture).find((b) => b.textContent?.trim() === target.name)!;

    row.click();
    fixture.detectChanges();

    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { filmLook: target.id });
    expect(el(fixture).querySelector('[data-testid="film-strength-row"]')).toBeTruthy();
    expect(row.classList.contains('film-look-row--active')).toBe(true);
  });

  it('clicking None after a look is selected clears filmLook and hides the strength slider', () => {
    const { fixture, state } = makeFixture();
    lookButtons(fixture)
      .find((b) => b.textContent?.trim() === FILM_CATALOG[0].name)!
      .click();
    fixture.detectChanges();
    state.updateAdjustment.mockClear();

    lookButtons(fixture)[0].click(); // None
    fixture.detectChanges();

    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { filmLook: '' });
    expect(el(fixture).querySelector('[data-testid="film-strength-row"]')).toBeNull();
  });

  it('dragging the strength slider calls updateAdjustment with { filmStrength }', () => {
    const { fixture, state } = makeFixture();
    lookButtons(fixture)
      .find((b) => b.textContent?.trim() === FILM_CATALOG[0].name)!
      .click();
    fixture.detectChanges();

    fixture.componentInstance.onStrengthChange(65);

    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { filmStrength: 65 });
  });
});
