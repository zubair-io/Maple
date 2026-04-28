// Left sidebar — collapsible sections, nested folder tree, smart items, albums.
// Ported from _design-reference/lib/tree.jsx MapleFileTree / FolderNode / TreeSection.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgTemplateOutlet, DecimalPipe } from '@angular/common';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent, MapleIconName } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';

@Component({
  selector: 'app-folder-tree',
  standalone: true,
  imports: [MapleIconComponent, NgTemplateOutlet, DecimalPipe],
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        background: var(--maple-sidebar);
        border-right: 0.5px solid var(--maple-border);
        overflow-y: auto;
        padding-bottom: 12px;
        box-sizing: border-box;
      }

      /* Scrollbar styling to match reference */
      :host::-webkit-scrollbar {
        width: 6px;
      }
      :host::-webkit-scrollbar-track {
        background: transparent;
      }
      :host::-webkit-scrollbar-thumb {
        background: var(--maple-border);
        border-radius: 3px;
      }

      .section-header {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px 4px 8px;
        margin: 6px 6px 0;
        border-radius: 5px;
        cursor: pointer;
      }
      .section-header:hover {
        background: var(--maple-bg-hover);
      }

      .section-label {
        font-family: var(--maple-font);
        font-size: 10px;
        font-weight: 600;
        color: var(--maple-text-muted);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        flex: 1;
      }

      .tree-row {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        margin: 0 6px;
        border-radius: 5px;
        font-family: var(--maple-font);
        font-size: 12px;
        cursor: pointer;
        transition: background 120ms;
      }
      .tree-row:hover:not(.selected) {
        background: var(--maple-bg-hover);
      }
      .tree-row.selected {
        background: var(--maple-primary-dim);
        color: var(--maple-primary);
        font-weight: 500;
      }
      .tree-row:not(.selected) {
        color: var(--maple-text-main);
      }

      .subheader {
        font-family: var(--maple-font);
        font-size: 10px;
        font-weight: 600;
        color: var(--maple-text-muted);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 10px 18px 4px;
      }

      .count {
        font-family: var(--maple-font-mono);
        font-size: 10px;
        color: var(--maple-text-muted);
        font-variant-numeric: tabular-nums;
        margin-right: 4px;
      }

      .chevron-btn {
        display: flex;
        width: 12px;
        justify-content: center;
        align-items: center;
        flex-shrink: 0;
      }

      .spacer {
        width: 12px;
        flex-shrink: 0;
      }

      .item-label {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .folder-tree-header {
        display: flex;
        align-items: center;
        padding: 8px 10px 4px 12px;
      }

      .header-label {
        font-family: var(--maple-font);
        font-size: 11px;
        font-weight: 600;
        color: var(--maple-text-muted);
        letter-spacing: 0.04em;
        flex: 1;
      }

      .add-folder-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: none;
        background: transparent;
        border-radius: 4px;
        color: var(--maple-text-muted);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        transition: background 120ms, color 120ms;
      }

      .add-folder-btn:hover {
        background: var(--maple-bg-hover);
        color: var(--maple-text-main);
      }
    `,
  ],
  template: `
    <div class="folder-tree-header">
      <span class="header-label">Library</span>
      <button
        class="add-folder-btn"
        type="button"
        title="Add a folder to your library"
        (click)="state.openLibraryPicker()"
        aria-label="Add folder"
      >+</button>
    </div>

    @for (section of state.sidebarTree(); track section.id) {
      <!-- Section header (e.g. "Folders", "Photos Library") -->
      <div class="section-header" (click)="state.toggleSection(section.id)">
        <maple-icon
          [name]="state.sectionOpen()[section.id] ? 'chevron-down' : 'chevron-right'"
          [size]="10"
          color="var(--maple-text-muted)"
          [strokeWidth]="2"
        />
        <span class="section-label">{{ section.label }}</span>
      </div>

      @if (state.sectionOpen()[section.id]) {
        <div style="margin-top:2px">
          @for (child of section.children || []; track child.id) {
            @if (child.kind === 'subheader') {
              <div class="subheader">{{ child.label }}</div>
            } @else if (child.kind === 'folder') {
              <!-- Recursive folder node (2 levels max in mock) -->
              <ng-container
                *ngTemplateOutlet="folderNode; context: { $implicit: child, level: 1 }"
              />
            } @else {
              <!-- Smart item or album row -->
              <div
                class="tree-row"
                [class.selected]="state.selectedSourceId() === child.id"
                [style.padding-left.px]="8 + 1 * 14"
                [style.padding-right.px]="10"
                (click)="state.selectedSourceId.set(child.id)"
              >
                <div class="spacer"></div>
                <maple-icon
                  [name]="iconForSmartOrAlbum(child)"
                  [size]="13"
                  [color]="
                    state.selectedSourceId() === child.id
                      ? 'var(--maple-primary)'
                      : 'var(--maple-text-muted)'
                  "
                />
                <span class="item-label">{{ child.label }}</span>
                @if (child.count != null) {
                  <span class="count">{{ child.count | number }}</span>
                }
              </div>
            }
          }
        </div>
      }
    }

    <!-- Recursive folder-node template -->
    <ng-template #folderNode let-node let-level="level">
      @let isOpen = isFolderOpen(node);
      @let isSelected = state.selectedSourceId() === node.id;
      @let hasChildren = (node.children?.length ?? 0) > 0;

      <div
        class="tree-row"
        [class.selected]="isSelected"
        [style.padding-left.px]="8 + level * 14"
        [style.padding-right.px]="10"
        (click)="onFolderClick(node, $event)"
      >
        <!-- Expand/collapse chevron or spacer -->
        @if (hasChildren) {
          <div class="chevron-btn" (click)="onChevronClick(node, $event)">
            <maple-icon
              [name]="isOpen ? 'chevron-down' : 'chevron-right'"
              [size]="10"
              color="var(--maple-text-muted)"
              [strokeWidth]="2"
            />
          </div>
        } @else {
          <div class="spacer"></div>
        }

        <!-- Folder icon -->
        <maple-icon
          [name]="isOpen && hasChildren ? 'folder-open' : 'folder'"
          [size]="13"
          [color]="isSelected ? 'var(--maple-primary)' : 'var(--maple-text-muted)'"
        />

        <!-- Name -->
        <span class="item-label">{{ node.label }}</span>

        <!-- Count -->
        @if (node.count != null) {
          <span class="count">{{ node.count }}</span>
        }
      </div>

      <!-- Children (next nesting level) -->
      @if (isOpen && hasChildren) {
        @for (child of node.children!; track child.id) {
          @if (child.kind === 'folder') {
            <ng-container
              *ngTemplateOutlet="folderNode; context: { $implicit: child, level: level + 1 }"
            />
          }
        }
      }
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeComponent {
  state = inject(LibraryStateService);

  isFolderOpen(node: SidebarEntry): boolean {
    const map = this.state.folderOpen();
    return map[node.id] !== undefined ? map[node.id] : node.open === true;
  }

  onFolderClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    this.state.selectedSourceId.set(node.id);
  }

  onChevronClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    this.state.setFolderOpen(node.id, !this.isFolderOpen(node));
  }

  iconForSmartOrAlbum(entry: SidebarEntry): MapleIconName {
    if (entry.kind === 'album') return 'tag';
    const map: Record<string, MapleIconName> = {
      photos: 'photos',
      heart: 'heart',
      check: 'check',
      x: 'x',
    };
    return entry.icon && map[entry.icon] ? map[entry.icon] : 'dot';
  }
}
