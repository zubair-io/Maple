// MuiFilmPanel — Maple UI Organisms (unified-component-catalog.md §4.3
// "Inspectors & panels"). Look catalog with strength — built from Chip Row,
// Card, Living Slider.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiCardComponent } from '../card/mui-card.component';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiLivingSliderComponent } from '../living-slider/mui-living-slider.component';

export interface MuiFilmLook {
  readonly id: string;
  readonly name: string;
  readonly src: string;
  readonly category: string;
}

@Component({
  selector: 'mui-film-panel',
  standalone: true,
  imports: [
    MuiCardComponent,
    MuiChipRowComponent,
    MuiEmptyStateComponent,
    MuiLivingSliderComponent,
  ],
  templateUrl: './mui-film-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class MuiFilmPanelComponent {
  /** Empty means "show all looks, no category filter row". */
  readonly categories = input<readonly MuiChip[]>([]);
  readonly looks = input.required<readonly MuiFilmLook[]>();
  readonly strength = model<number>(100);
  readonly activeCategoryId = model<string | null>(null);
  readonly selectedLookId = model<string | null>(null);

  /** Fires on double-click — distinct from mere selection. */
  readonly looksApplied = output<string>();

  readonly visibleLooks = computed(() => {
    const categoryId = this.activeCategoryId();
    const looks = this.looks();
    return categoryId === null ? looks : looks.filter((look) => look.category === categoryId);
  });

  selectLook(id: string): void {
    this.selectedLookId.set(id);
  }

  applyLook(id: string): void {
    this.looksApplied.emit(id);
  }
}
