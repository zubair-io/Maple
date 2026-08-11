// FilmPanelComponent — unit tests (epic #2683, Task 12; category picker
// #2780).
//
// Strategy mirrors `profile-section.component.spec.ts`: stub
// `LibraryStateService` with a writable signal so the active `filmLook` /
// `filmStrength` can be flipped, and stub `EditorStateService.armedTool`
// with a writable signal so the chip row's "derive on (re-)arm" effect
// (parity with Apple's `FilmSection.onAppear`) can be exercised. Assert the
// 6 category chips render in catalog order, only the selected category's
// looks are listed (with None pinned above them regardless of category),
// clicking a chip swaps the list, selection dispatches
// `updateAdjustment({ filmLook })`, the strength slider only shows once a
// look is active, and the active look's category is what the chip row lands
// on both at construction and whenever Film is re-armed.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';

import { FilmPanelComponent } from './film-panel.component';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { FILM_CATALOG, type FilmCategory } from '../../generated/film-catalog.generated';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';
import type { ToolId } from '../../editor/tool-model';

const ASSET_ID = 'local-asset-1';

class FakeLibraryStateService {
  focusedAssetId = signal<string | undefined>(ASSET_ID);
  private adj = signal<AdjustmentModel>({ ...defaultAdjustmentModel() });
  adjustmentFor = vi.fn(() => this.adj);
  updateAdjustment = vi.fn((_id: string, patch: Partial<AdjustmentModel>) => {
    this.adj.update((m) => ({ ...m, ...patch }));
  });
}

class FakeEditorStateService {
  armedTool = signal<ToolId>('filmLook');
}

function makeFixture() {
  const state = new FakeLibraryStateService();
  const editorState = new FakeEditorStateService();
  TestBed.configureTestingModule({
    imports: [FilmPanelComponent],
    providers: [
      { provide: LibraryStateService, useValue: state },
      { provide: EditorStateService, useValue: editorState },
    ],
  });
  const fixture = TestBed.createComponent(FilmPanelComponent);
  fixture.detectChanges();
  return { fixture, state, editorState };
}

function el(fixture: ReturnType<typeof TestBed.createComponent>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function lookButtons(fixture: ReturnType<typeof TestBed.createComponent>): HTMLButtonElement[] {
  return Array.from(el(fixture).querySelectorAll<HTMLButtonElement>('.film-look-row'));
}

function categoryChips(fixture: ReturnType<typeof TestBed.createComponent>): HTMLButtonElement[] {
  return Array.from(el(fixture).querySelectorAll<HTMLButtonElement>('.film-category-chip'));
}

/** Lands the chip row on `look`'s category, then clicks its row — the list
 *  only shows one category at a time, so a look outside the default
 *  selection needs its chip picked first. */
function clickLook(
  fixture: ReturnType<typeof TestBed.createComponent>,
  look: (typeof FILM_CATALOG)[number],
): void {
  categoryChips(fixture)
    .find((c) => c.dataset['testid'] === `film-category-${look.category}`)!
    .click();
  fixture.detectChanges();
  lookButtons(fixture)
    .find((b) => b.textContent?.trim() === look.name)!
    .click();
  fixture.detectChanges();
}

/** `black_white`'s catalog entries — a category NOT first in declaration
 *  order, useful for asserting the list is actually filtered rather than
 *  coincidentally showing category #1. */
const BW_LOOK = FILM_CATALOG.find((e) => e.category === 'black_white')!;
const BW_CATEGORY: FilmCategory = 'black_white';

describe('FilmPanelComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders 6 category chips in catalog declaration order', () => {
    const { fixture } = makeFixture();
    const chips = categoryChips(fixture);
    expect(chips.length).toBe(6);
    expect(new Set(chips.map((c) => c.textContent?.trim())).size).toBe(6);
    // First chip (color_negative) is selected by default (first category,
    // since the pristine model has no active look).
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
  });

  it("lists only the selected category's looks, plus the always-present None row", () => {
    const { fixture } = makeFixture();
    const colorNegCount = FILM_CATALOG.filter((e) => e.category === 'color_negative').length;
    const rows = lookButtons(fixture);
    // +1 for None.
    expect(rows.length).toBe(colorNegCount + 1);
    expect(rows[0].textContent?.trim()).toBe('None');

    // A look from a category NOT currently selected is absent from the list.
    expect(rows.some((r) => r.textContent?.trim() === BW_LOOK.name)).toBe(false);
  });

  it('clicking a category chip swaps the list to that category, keeping None pinned', () => {
    const { fixture } = makeFixture();
    const bwChip = categoryChips(fixture).find(
      (c) => c.dataset['testid'] === `film-category-${BW_CATEGORY}`,
    )!;

    bwChip.click();
    fixture.detectChanges();

    const bwCount = FILM_CATALOG.filter((e) => e.category === BW_CATEGORY).length;
    const rows = lookButtons(fixture);
    expect(rows.length).toBe(bwCount + 1);
    expect(rows[0].textContent?.trim()).toBe('None');
    expect(rows.some((r) => r.textContent?.trim() === BW_LOOK.name)).toBe(true);
    expect(bwChip.getAttribute('aria-pressed')).toBe('true');
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
    clickLook(fixture, target);

    const row = lookButtons(fixture).find((b) => b.textContent?.trim() === target.name)!;
    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { filmLook: target.id });
    expect(el(fixture).querySelector('[data-testid="film-strength-row"]')).toBeTruthy();
    expect(row.classList.contains('film-look-row--active')).toBe(true);
  });

  it('clicking None after a look is selected clears filmLook and hides the strength slider', () => {
    const { fixture, state } = makeFixture();
    clickLook(fixture, FILM_CATALOG[0]);
    state.updateAdjustment.mockClear();

    lookButtons(fixture)[0].click(); // None
    fixture.detectChanges();

    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { filmLook: '' });
    expect(el(fixture).querySelector('[data-testid="film-strength-row"]')).toBeNull();
  });

  it('dragging the strength slider calls updateAdjustment with { filmStrength }', () => {
    const { fixture, state } = makeFixture();
    clickLook(fixture, FILM_CATALOG[0]);

    fixture.componentInstance.onStrengthChange(65);

    expect(state.updateAdjustment).toHaveBeenCalledWith(ASSET_ID, { filmStrength: 65 });
  });

  it("derives the selected category from the active look's category on init", () => {
    const state = new FakeLibraryStateService();
    // Pre-seed an active look BEFORE the component is constructed, so the
    // constructor effect's initial run is what derives the category.
    state.adjustmentFor = vi.fn(() =>
      signal({ ...defaultAdjustmentModel(), filmLook: BW_LOOK.id }),
    );
    const editorState = new FakeEditorStateService();
    TestBed.configureTestingModule({
      imports: [FilmPanelComponent],
      providers: [
        { provide: LibraryStateService, useValue: state },
        { provide: EditorStateService, useValue: editorState },
      ],
    });
    const fixture = TestBed.createComponent(FilmPanelComponent);
    fixture.detectChanges();

    const bwChip = categoryChips(fixture).find(
      (c) => c.dataset['testid'] === `film-category-${BW_CATEGORY}`,
    )!;
    expect(bwChip.getAttribute('aria-pressed')).toBe('true');
    expect(lookButtons(fixture).some((r) => r.textContent?.trim() === BW_LOOK.name)).toBe(true);
  });

  it('re-derives the selected category when Film is re-armed with a different active look', () => {
    const { fixture, state, editorState } = makeFixture();

    // Arm away from Film, change the active look underneath (as if the user
    // picked a look, then left, then something else changed it), then
    // manually flip the chip row to a different category to prove the
    // re-arm effect overrides it rather than leaving the stale selection.
    editorState.armedTool.set('exposure');
    fixture.detectChanges();

    state.updateAdjustment(ASSET_ID, { filmLook: BW_LOOK.id });
    fixture.detectChanges();
    fixture.componentInstance.selectCategory('slide');
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedCategory()).toBe('slide');

    editorState.armedTool.set('filmLook');
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedCategory()).toBe(BW_CATEGORY);
    const bwChip = categoryChips(fixture).find(
      (c) => c.dataset['testid'] === `film-category-${BW_CATEGORY}`,
    )!;
    expect(bwChip.getAttribute('aria-pressed')).toBe('true');
  });
});
