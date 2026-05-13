// Folder tile rendered inline in the asset grid (Self-Hosted FS-walk only).
// Sibling to <maple-asset-thumb> — same parent dimensions (set by the grid's
// justified row layout) but renders a folder affordance + name instead of
// a RAW preview. Click drills into the folder via LibraryStateService.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { GridFolderItem } from '../../models/folder';

@Component({
  selector: 'maple-folder-tile',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './folder-tile.component.html',
  styleUrl: './folder-tile.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTileComponent {
  folder = input.required<GridFolderItem>();
  selected = input<boolean>(false);

  folderClick = output<MouseEvent>();
  folderDblClick = output<MouseEvent>();
}
