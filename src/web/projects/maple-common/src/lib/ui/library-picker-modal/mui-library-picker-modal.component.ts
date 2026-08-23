// MuiLibraryPickerModal — Maple UI Organisms (unified-component-catalog.md
// §4.4). Remote filesystem browser, built from Overlay Shell, Toolbar
// (breadcrumb + back/refresh actions), Tree Row (flat folder/file listing),
// and Empty State. Handles loading/error/empty/populated per the catalog's
// data-states rule — each is driven from an input, never hardcoded.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiBannerComponent } from '../banner/mui-banner.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';
import type { MuiToolbarEntry } from '../toolbar/mui-toolbar.component';
import { MuiToolbarComponent } from '../toolbar/mui-toolbar.component';
import { MuiTreeRowComponent } from '../tree-row/mui-tree-row.component';

export interface MuiLibraryPickerEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: 'folder' | 'file';
  readonly itemCount?: number;
}

const NAV_BACK_ID = 'nav:back';
const NAV_REFRESH_ID = 'nav:refresh';
const CRUMB_PREFIX = 'crumb:';

@Component({
  selector: 'mui-library-picker-modal',
  standalone: true,
  imports: [
    MuiBannerComponent,
    MuiButtonComponent,
    MuiEmptyStateComponent,
    MuiOverlayShellComponent,
    MuiSpinnerComponent,
    MuiTextComponent,
    MuiToolbarComponent,
    MuiTreeRowComponent,
  ],
  templateUrl: './mui-library-picker-modal.component.html',
  styleUrl: './mui-library-picker-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiLibraryPickerModalComponent {
  readonly open = input<boolean>(false);
  readonly pathSegments = input.required<readonly string[]>();
  readonly entries = input.required<readonly MuiLibraryPickerEntry[]>();
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly selectedId = model<string | null>(null);

  /** A file entry was clicked (selected, not opened). */
  readonly entrySelected = output<string>();
  /** A folder entry — or an ancestor breadcrumb — was opened. */
  readonly folderOpened = output<string>();
  readonly dismissed = output<void>();
  /** The current selection was confirmed as the final pick. */
  readonly chosen = output<void>();
  readonly backRequested = output<void>();
  readonly refreshRequested = output<void>();

  readonly toolbarEntries = computed<readonly MuiToolbarEntry[]>(() => {
    const crumbs = this.pathSegments().map((segment, index) => ({
      id: `${CRUMB_PREFIX}${index}`,
      icon: 'folder' as const,
      label: segment,
    }));
    return [
      {
        id: NAV_BACK_ID,
        icon: 'back' as const,
        label: 'Back',
        disabled: this.pathSegments().length === 0,
      },
      ...crumbs,
      { divider: true as const },
      { id: NAV_REFRESH_ID, icon: 'revert' as const, label: 'Refresh' },
    ];
  });

  onToolbarSelected(id: string): void {
    if (id === NAV_BACK_ID) {
      this.backRequested.emit();
      return;
    }
    if (id === NAV_REFRESH_ID) {
      this.refreshRequested.emit();
      return;
    }
    if (id.startsWith(CRUMB_PREFIX)) {
      const index = Number.parseInt(id.slice(CRUMB_PREFIX.length), 10);
      const segment = this.pathSegments()[index];
      if (segment !== undefined) this.folderOpened.emit(segment);
    }
  }

  onEntryPressed(entry: MuiLibraryPickerEntry): void {
    if (entry.kind === 'folder') {
      this.folderOpened.emit(entry.name);
      return;
    }
    this.selectedId.set(entry.id);
    this.entrySelected.emit(entry.id);
  }
}
