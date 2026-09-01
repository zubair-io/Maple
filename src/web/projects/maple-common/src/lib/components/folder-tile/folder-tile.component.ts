// Folder tile rendered in the asset grid's folder section (Self-Hosted
// FS-walk only). Fixed 180×64 landscape tile — the parent grid sets the
// dimensions — laid out like the Windows `BrowseFolderTiles` template
// (#3099): primary-red folder outline, 10px gap, body label with a tail
// ellipsis, 14px side padding, 4px radius on a `surface` ground. Click
// drills into the folder via LibraryStateService.
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
  host: { class: 'block w-full h-full' },
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
