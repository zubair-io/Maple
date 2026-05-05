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
  template: `
    @let f = folder();
    <div
      class="folder-tile relative flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[2px] bg-surface text-text-main outline-none"
      [class.selected]="selected()"
      (click)="folderClick.emit($event)"
      (dblclick)="folderDblClick.emit($event)"
    >
      <maple-icon name="folder" [size]="36" color="var(--color-text-muted)" [strokeWidth]="1.25" />
      <span class="px-2 text-[11px] font-medium text-text-main truncate max-w-full">{{ f.name }}</span>
      <div class="folder-ring pointer-events-none absolute inset-0 rounded-[2px] border-2 border-transparent transition-[border-color] duration-[80ms]" aria-hidden="true"></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }

      .folder-tile {
        background: var(--color-surface);
        border: 0.5px solid var(--color-border);
      }

      .folder-tile:hover {
        background: var(--color-bg-hover);
      }

      .folder-tile.selected .folder-ring {
        border-color: var(--color-primary);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTileComponent {
  folder = input.required<GridFolderItem>();
  selected = input<boolean>(false);

  folderClick = output<MouseEvent>();
  folderDblClick = output<MouseEvent>();
}
