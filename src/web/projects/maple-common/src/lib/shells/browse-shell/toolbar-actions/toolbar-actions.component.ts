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

  /** Self-Hosted only gates Edit Metadata / Merge to panorama — see the
   * comment ported from browse-shell.component.html on the Copy/Paste/Sync
   * buttons for why those three (and Export) are NOT backend-gated. */
  readonly selfHosted = input.required<boolean>();

  readonly canEditMetadata = input.required<boolean>();
  readonly canMergePano = input.required<boolean>();
  readonly canCopySettings = input.required<boolean>();
  readonly canPasteSettings = input.required<boolean>();
  readonly canSyncSettings = input.required<boolean>();
  readonly selectedCount = input.required<number>();

  readonly editMetadata = output<void>();
  readonly mergePano = output<void>();
  readonly copySettings = output<void>();
  readonly openPasteDialog = output<void>();
  readonly syncSettings = output<void>();

  /** True while the collapsed kebab menu is open. */
  protected readonly overflowMenuOpen = signal(false);
  protected toggleOverflowMenu(): void {
    this.overflowMenuOpen.update((v) => !v);
  }
  protected closeOverflowMenu(): void {
    this.overflowMenuOpen.set(false);
  }
}
