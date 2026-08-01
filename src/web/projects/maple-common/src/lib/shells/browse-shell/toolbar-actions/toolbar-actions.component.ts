// BrowseShell toolbar action pills — extracted from browse-shell.component.html
// (#2280 fallow-audit-web fix, PR #2293) to drop the parent template's
// complexity below the fallow CRITICAL threshold. Behavior is unchanged:
// inline pill row at desktop, collapsed into a kebab menu below the desktop
// breakpoint (same `overflowMenuOpen` toggle, now owned locally since no
// other part of BrowseShell reads it).
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MapleIconComponent } from '../../../icons/maple-icon.component';

@Component({
  selector: 'app-toolbar-actions',
  standalone: true,
  imports: [NgTemplateOutlet, MapleIconComponent],
  templateUrl: './toolbar-actions.component.html',
  styleUrl: './toolbar-actions.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolbarActionsComponent {
  /** True below the desktop breakpoint — collapses the pill row into a
   * kebab-triggered menu instead of an inline row. */
  readonly collapsed = input.required<boolean>();

  readonly canCopySettings = input.required<boolean>();
  readonly canPasteSettings = input.required<boolean>();
  readonly canSyncSettings = input.required<boolean>();
  readonly selectedCount = input.required<number>();

  /** True while Select mode is on (#2404) — session signal on
   * LibraryStateService, reflected here via `aria-pressed` and an
   * active-tint style, same as Apple's `BrowseVM.isSelecting` toggle. */
  readonly isSelecting = input.required<boolean>();

  readonly copySettings = output<void>();
  readonly openPasteDialog = output<void>();
  readonly syncSettings = output<void>();
  readonly toggleSelectMode = output<void>();

  /** True while the collapsed kebab menu is open. */
  protected readonly overflowMenuOpen = signal(false);
  protected toggleOverflowMenu(): void {
    this.overflowMenuOpen.update((v) => !v);
  }
  protected closeOverflowMenu(): void {
    this.overflowMenuOpen.set(false);
  }
}
