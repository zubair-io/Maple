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
// + `TypedStorage.set(STORAGE_KEYS.FILTER, ...)` so phone/desktop share
// the same persistence key.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { Asset } from '../models/asset';
import { viewRouteCommands } from '../addressing/route-address';
import { BrowsePreferencesService, CullFilter } from '../state/browse-preferences.service';
import { LibrarySelection } from '../state/library-selection.service';
import { FilterChipsComponent } from './filter-chips.component';
import { LibraryCellComponent } from './library-cell.component';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';

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

  /** Reference to the `.grid` element so the filter-swap cross-fade can
   *  be restarted imperatively. CSS `animation` only runs on element
   *  insert, and `@for` only re-creates the cells (not the parent), so
   *  there is no way to retrigger the keyframe declaratively. The
   *  Apple side uses `.id("library-grid-\(filter)")` to remount the
   *  grid; the web equivalent is the class toggle + reflow below. */
  private readonly gridEl = viewChild<ElementRef<HTMLElement>>('grid');

  constructor() {
    effect(() => {
      // Track the filter signal so the effect re-runs on every change.
      this.filter();
      const el = this.gridEl()?.nativeElement;
      if (!el) return;
      // Remove → force reflow → re-add to restart the keyframe. The
      // `offsetWidth` read is the canonical way to flush layout so the
      // browser treats the next class addition as a fresh insert.
      el.classList.remove('is-fading');
      void el.offsetWidth;
      el.classList.add('is-fading');
    });
  }

  /** Filtered + sorted asset list. The service computes the filter +
   *  search + sort from `BrowsePreferencesService.filter()` already. */
  readonly assets = this.selection.assetsInSelectedFolder;

  /** Title row label — current sidebar selection's display name. */
  readonly sourceLabel = computed(() => this.selection.selectedSourceLabel() || 'Library');

  /** trackBy for the asset *ngFor. */
  trackAsset = (_: number, asset: Asset): string => asset.id;

  onFilterChange(next: CullFilter): void {
    this.prefs.filter.set(next);
    TypedStorage.set(STORAGE_KEYS.FILTER, next);
  }

  onCellTap(asset: Asset): void {
    this.selection.selectAsset(asset.id);
    // Task 6b (Web Preview Surface): tapping a Library cell opens the fast
    // Preview surface — the editor canvas is no longer the first stop after
    // a tap. Edit still enters the full responsive Editor from there. See
    // docs/design/responsive-program/s5-editor.md §"User Flow".
    void this.router.navigate(viewRouteCommands(asset.id));
  }
}
