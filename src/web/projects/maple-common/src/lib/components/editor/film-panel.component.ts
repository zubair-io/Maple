// FilmPanelComponent — film-look catalog picker + strength slider
// (epic #2683, Task 12).
//
// Projected into `pro-control-card`'s `cardBodyFilm` slot (same shape as
// `pro-color-grading-panel`'s `cardBodyGrade`) whenever the Film sub-tool
// chip is armed. Lists the 100-entry `FILM_CATALOG` grouped by its 6
// categories, plus a "None" row that clears the look. The strength slider
// only shows once a look is selected — there is nothing to mix strength
// against on "None".
//
// Writes go straight to `LibraryStateService.updateAdjustment`, the same
// single write path `ColorGradingPanelComponent`/the WB pad use — the
// debounced sidecar write + preview persist happen downstream of that call.
// This component does NOT fetch the `.mlut` bytes itself: that is the
// canvas/session glue's job (`image-canvas.film.ts`), which watches
// `adjustmentFor(id)().filmLook` and posts `set-film-lut` to the worker —
// the panel only ever writes the catalog id + strength scalar.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { LivingSliderComponent } from '../develop/living-slider.component';
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

const STRENGTH_RANGE = ADJUSTMENT_RANGES.filmStrength;

@Component({
  selector: 'film-panel',
  standalone: true,
  imports: [LivingSliderComponent],
  templateUrl: './film-panel.component.html',
  styleUrl: './film-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FilmPanelComponent {
  private readonly library = inject(LibraryStateService);

  readonly groups = CATEGORY_GROUPS;
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

  isActive(lookId: string): boolean {
    return this.activeLookId() === lookId;
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
