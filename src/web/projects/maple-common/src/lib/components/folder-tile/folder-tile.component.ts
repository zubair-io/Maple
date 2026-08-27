// Folder tile rendered inline in the asset grid (Self-Hosted FS-walk only).
// Sibling to `<maple-asset-tile>` — same parent dimensions (set by the
// grid's justified row layout) but renders a folder affordance + name
// instead of a RAW preview. Click drills into the folder via
// LibraryStateService.
//
// Composed from Maple UI atoms (mui-icon, mui-text) rather than
// `mui-media-cell` (MW6, ticket #3047) — this tile has no image, no
// badges, no rating, which makes `mui-media-cell` a poor fit on its own
// (noted when MW4/#3031 scoped this migration out originally). The
// `role="button"` + keyboard-activation pattern below matches
// `mui-media-cell`'s own `stacked`-layout root, for consistency with the
// rest of the grid's tile chrome. Enter/Space activation is new — a small,
// incidental a11y fix that composing onto the shared activation helper
// gives for free (this tile previously had no keyboard affordance at all).

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { GridFolderItem } from '../../models/folder';
import { MuiIconComponent } from '../../ui/icon/mui-icon.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import { handleActivationKeydown } from '../../ui/internal/activation-keydown';

@Component({
  selector: 'maple-folder-tile',
  standalone: true,
  imports: [MuiIconComponent, MuiTextComponent],
  templateUrl: './folder-tile.component.html',
  styleUrl: './folder-tile.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTileComponent {
  folder = input.required<GridFolderItem>();
  selected = input<boolean>(false);

  folderClick = output<MouseEvent>();
  folderDblClick = output<MouseEvent>();

  /** The div root has no native keyboard activation the way a real
   * `<button>` would — Enter/Space needs wiring explicitly, same reason
   * `mui-media-cell`'s `stacked` layout needs it. */
  onKeydown(event: KeyboardEvent): void {
    // Modifier keys carried over so keyboard folder selection supports the
    // same additive/range behavior asset-grid reads off mouse clicks.
    handleActivationKeydown(event, () =>
      this.folderClick.emit(
        new MouseEvent('click', {
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        }),
      ),
    );
  }
}
