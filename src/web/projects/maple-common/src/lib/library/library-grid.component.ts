// library-grid.component.ts — S2 (#623). Responsive Library grid for
// the web shell.
//
// Layout is CSS-only (per spec §4: "leaf components must not branch
// on layout"). The grid breakpoints live in
// `library-grid.component.scss`:
//
//   * phone   (<768px)  — 3 columns, 2px gap, 2px horizontal padding,
//                         no vertical padding (edge-bleed).
//   * tablet  (768–1024) — 5 columns, 4px gap, 8px outer padding.
//   * desktop (≥1025)    — `auto-fill minmax(180px, 1fr)`, 4px gap,
//                          12px outer padding.
//
// The component reads filtered assets straight off
// `LibrarySelection.assetsInSelectedFolder()` (a computed signal that
// already applies `BrowsePreferencesService.filter()`). Filter chip
// state writes back through `BrowsePreferencesService.filter.set(...)`
// + `localStorage.setItem('cm.filter', ...)` so phone/desktop share
// the same persistence key.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Asset } from '../models/asset';
import { BrowsePreferencesService, CullFilter } from '../state/browse-preferences.service';
import { LibrarySelection } from '../state/library-selection.service';
import { FilterChipsComponent } from './filter-chips.component';
import { LibraryCellComponent } from './library-cell.component';

@Component({
  selector: 'app-library-grid',
  standalone: true,
  imports: [FilterChipsComponent, LibraryCellComponent],
  templateUrl: './library-grid.component.html',
  styleUrl: './library-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryGridComponent {
  private readonly prefs = inject(BrowsePreferencesService);
  private readonly selection = inject(LibrarySelection);
  private readonly router = inject(Router);

  /** Currently-active filter chip. */
  readonly filter = this.prefs.filter;

  /** Filtered + sorted asset list. The service computes the filter +
   *  search + sort from `BrowsePreferencesService.filter()` already. */
  readonly assets = this.selection.assetsInSelectedFolder;

  /** Title row label — current sidebar selection's display name. */
  readonly sourceLabel = computed(() => this.selection.selectedSourceLabel() || 'Library');

  /** trackBy for the asset *ngFor. */
  trackAsset = (_: number, asset: Asset): string => asset.id;

  onFilterChange(next: CullFilter): void {
    this.prefs.filter.set(next);
    try {
      localStorage.setItem('cm.filter', JSON.stringify(next));
    } catch {
      /* noop */
    }
  }

  onCellTap(asset: Asset): void {
    this.selection.selectAsset(asset.id);
    // TODO(S5): push directly to the Editor when the responsive
    // Editor lands. Until then route through the existing /edit/:id
    // path so cell taps still open something.
    void this.router.navigate(['/edit', asset.id]);
  }
}
