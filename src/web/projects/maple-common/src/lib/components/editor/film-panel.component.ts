// FilmPanelComponent — film-look catalog picker + strength slider
// (epic #2683, Task 12).
//
// Projected into `pro-control-card`'s `cardBodyFilm` slot (same shape as
// `pro-color-grading-panel`'s `cardBodyGrade`) whenever the Film sub-tool
// chip is armed. Lists the 100-entry `FILM_CATALOG` behind a horizontal
// category chip row — UX parity with Apple's `FilmSection` (#2683 round 2):
// one category's ~10-20 looks at a time instead of all 100 stacked into a
// single scroll, plus a "None" row pinned above the filtered list that
// clears the look regardless of which category is selected. The strength
// slider only shows once a look is selected — there is nothing to mix
// strength against on "None".
//
// The chip row reuses `pro-control-card`'s sub-tool chip idiom (`.subtool-row`
// / `.subtool-chip` in `control-card.component.scss`) rather than inventing
// new chrome — see `.film-category-row` / `.film-category-chip` below,
// styled identically but scoped to this component (Angular's `styleUrl`
// encapsulation means the class names can't just be shared across files).
//
// `selectedCategory` is local UI state, not part of the edit model. Unlike
// `FilmSection` (a SwiftUI view re-mounted by `FlyoutSliderPanel`'s tool-swap
// branches, so `.onAppear` naturally re-fires every time Film is (re-)armed),
// this component is instantiated once by `EditorShellComponent`'s
// `ngTemplateOutlet` and stays alive across tool switches — content
// projection doesn't tear it down when `cardBodyFilm` isn't the slot in
// view. So parity with "derive on mount" is reproduced explicitly via the
// constructor effect below, keyed on TWO identities rather than one:
//
//   - `armedTool()` transitioning TO `'filmLook'` (including the first run,
//     on construction) — "re-open Film → land on whichever category the
//     current look belongs to", `FilmSection.onAppear`'s behavior.
//   - `focusedAssetId()` changing WHILE already armed on Film — filmstrip
//     navigation doesn't re-arm the tool, so without this the chip row goes
//     stale when the user browses photos with Film left open: the new
//     asset's active look silently falls outside the still-selected
//     category and the visible list simply omits it (round 1 review fix).
//
// Deliberately NOT keyed on `activeLookId()` itself: that value also
// changes when the user manually picks a look or clicks "None" on the SAME
// asset, and re-deriving on every such tick would yank the chip row away
// mid-browse the instant they clear a look (an empty `filmLook` resolves to
// the first category, which may not be the one they're looking at). Only
// asset identity changing (a new asset was navigated to) — or the tool
// arming — should move the chip row; a look edit on the asset already open
// must not.
//
// Writes go straight to `LibraryStateService.updateAdjustment`, the same
// single write path `ColorGradingPanelComponent`/the WB pad use — the
// debounced sidecar write + preview persist happen downstream of that call.
// This component does NOT fetch the `.mlut` bytes itself: that is the
// canvas/session glue's job (`image-canvas.film.ts`), which watches
// `adjustmentFor(id)().filmLook` and posts `set-film-lut` to the worker —
// the panel only ever writes the catalog id + strength scalar.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { MuiLivingSliderComponent } from '../../ui/living-slider/mui-living-slider.component';
import { FILM_CATALOG, type FilmCategory } from '../../generated/film-catalog.generated';
import { ADJUSTMENT_RANGES, type AdjustmentModel } from '../../models/adjustment-model';

/** Display order + label for each of the catalog's 6 categories. */
const CATEGORY_ORDER: readonly FilmCategory[] = [
  'color_negative',
  'slide',
  'black_white',
  'cinema_print',
  'consumer_vintage',
  'instant',
];

const CATEGORY_LABEL: Record<FilmCategory, string> = {
  color_negative: 'Color Negative',
  slide: 'Slide',
  black_white: 'Black & White',
  cinema_print: 'Cinema Print',
  consumer_vintage: 'Consumer / Vintage',
  instant: 'Instant',
};

/** One category's row group, pre-filtered from `FILM_CATALOG`. */
interface FilmCategoryGroup {
  readonly category: FilmCategory;
  readonly label: string;
  readonly looks: ReadonlyArray<(typeof FILM_CATALOG)[number]>;
}

/** Grouped once at module scope — `FILM_CATALOG` is static generated data,
 *  so this never needs to recompute per component instance. */
const CATEGORY_GROUPS: readonly FilmCategoryGroup[] = CATEGORY_ORDER.map((category) => ({
  category,
  label: CATEGORY_LABEL[category],
  looks: FILM_CATALOG.filter((entry) => entry.category === category),
}));

/** The category chip row's options, in `CATEGORY_ORDER` declaration order —
 *  the six chips always present in the same order, mirroring
 *  `FilmCategory.allCases` on the Apple side. */
interface FilmCategoryOption {
  readonly id: FilmCategory;
  readonly label: string;
}
const CATEGORY_OPTIONS: readonly FilmCategoryOption[] = CATEGORY_ORDER.map((id) => ({
  id,
  label: CATEGORY_LABEL[id],
}));

const STRENGTH_RANGE = ADJUSTMENT_RANGES.filmStrength;

@Component({
  selector: 'film-panel',
  standalone: true,
  imports: [MuiLivingSliderComponent],
  templateUrl: './film-panel.component.html',
  styleUrl: './film-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilmPanelComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editorState = inject(EditorStateService);

  readonly categories = CATEGORY_OPTIONS;
  readonly strengthMin = STRENGTH_RANGE[0];
  readonly strengthMax = STRENGTH_RANGE[1];

  private readonly adj = computed<AdjustmentModel | null>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)() : null;
  });

  /** '' (the model default) when no look is selected — drives the "None"
   *  row's active state and gates the strength slider. */
  readonly activeLookId = computed<string>(() => this.adj()?.filmLook ?? '');

  readonly hasActiveLook = computed<boolean>(() => this.activeLookId().length > 0);

  readonly strength = computed<number>(() => this.adj()?.filmStrength ?? this.strengthMax);

  /** The category chip row's current selection — re-derived (see the
   *  constructor effect) rather than remembered indefinitely, so it always
   *  reflects the active look whenever Film is (re-)armed. */
  readonly selectedCategory = signal<FilmCategory>(CATEGORY_ORDER[0]);

  /** Only the SELECTED category's looks — the None row (rendered separately
   *  in the template) stays pinned above them regardless of category. */
  readonly activeGroup = computed<FilmCategoryGroup>(() => {
    const category = this.selectedCategory();
    return CATEGORY_GROUPS.find((group) => group.category === category) ?? CATEGORY_GROUPS[0];
  });

  constructor() {
    // See the file banner: re-derives `selectedCategory` from the active
    // look's category whenever Film (re-)arms OR the focused asset changes
    // while Film is already armed — never on a same-asset look edit. Both
    // `armedTool()` and `focusedAssetId()` are TRACKED (their identity is
    // exactly the "did the panel context change" signal this needs);
    // `activeLookId()` is read `untracked` so a manual look/None pick on
    // the same asset can't itself re-trigger this effect.
    effect(() => {
      const tool = this.editorState.armedTool();
      this.library.focusedAssetId(); // tracked for its identity only — the
      // value itself is re-read (untracked, via activeLookId) below.
      if (tool !== 'filmLook') return;
      const lookId = untracked(this.activeLookId);
      this.selectedCategory.set(FilmPanelComponent.defaultCategory(lookId));
    });
  }

  private static defaultCategory(lookId: string): FilmCategory {
    return FILM_CATALOG.find((entry) => entry.id === lookId)?.category ?? CATEGORY_ORDER[0];
  }

  isActive(lookId: string): boolean {
    return this.activeLookId() === lookId;
  }

  isCategoryActive(category: FilmCategory): boolean {
    return this.selectedCategory() === category;
  }

  selectCategory(category: FilmCategory): void {
    this.selectedCategory.set(category);
  }

  selectLook(lookId: string): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, { filmLook: lookId });
  }

  selectNone(): void {
    this.selectLook('');
  }

  onStrengthChange(value: number): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.library.updateAdjustment(id, { filmStrength: value });
  }

  onStrengthReset(): void {
    this.onStrengthChange(this.strengthMax);
  }
}
