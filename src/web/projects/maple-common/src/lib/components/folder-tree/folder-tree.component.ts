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
        background: var(--color-sidebar);
        border-right: 0.5px solid var(--color-border);
        overflow-y: auto;
        padding-bottom: 12px;
        box-sizing: border-box;
      }

      /* Scrollbar styling to match reference — webkit pseudo-elements
         can't be expressed as Tailwind utilities. */
      :host::-webkit-scrollbar {
        width: 6px;
      }
      :host::-webkit-scrollbar-track {
        background: transparent;
      }
      :host::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: 3px;
      }

      /* Spinner: needs animation + border-top-color override for the
         rotating accent ring. Both are awkward to express as utilities. */
      .chevron-spinner {
        border-top-color: var(--color-primary);
        animation: spin 700ms linear infinite;
      }

      /* @keyframes are not Tailwind-expressible. */
      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      /* Tree-row hover background + selected colors. We can't express the
         "only on hover when not selected" combination as a static utility
         (Tailwind has no :not() variant). Keep these pseudo-class rules
         so the selected highlight + non-selected hover both work without
         needing extra class bindings on every row. */
      .tree-row:hover:not(.selected) {
        background: var(--color-bg-hover);
      }
      .tree-row.selected {
        background: var(--color-primary-dim);
        color: var(--color-primary);
        font-weight: 500;
      }
    `,
  ],
  template: `
    <div class="flex items-center pl-4 pr-3 pt-3 pb-1.5">
      <span class="flex-1 text-[11px] font-semibold tracking-[0.04em] text-text-muted uppercase">Library</span>
      <button
        class="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border-none bg-transparent p-0 text-[18px] leading-none text-text-muted transition-[background,color] duration-[120ms] hover:bg-bg-hover hover:text-text-main"
        type="button"
        title="Add a folder to your library"
        (click)="state.openLibraryPicker()"
        aria-label="Add folder"
      >+</button>
    </div>

    @for (section of state.sidebarTree(); track section.id) {
      @if (section.kind === 'section') {
        <!-- Legacy section header (only renders if a stale 'Folders' section
             slipped through; the live state has libraries at the top level). -->
        <div class="mx-2 mt-1.5 flex cursor-pointer items-center gap-1.5 rounded-md py-1 pl-2 pr-3 hover:bg-bg-hover" (click)="state.toggleSection(section.id)">
          <maple-icon
            [name]="state.sectionOpen()[section.id] ? 'chevron-down' : 'chevron-right'"
            [size]="10"
            color="var(--color-text-muted)"
            [strokeWidth]="2"
          />
          <span class="flex-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">{{ section.label }}</span>
        </div>

        @if (state.sectionOpen()[section.id]) {
          <div class="mt-1">
            @for (child of section.children || []; track child.id) {
              @if (child.kind === 'folder') {
                <ng-container
                  *ngTemplateOutlet="folderNode; context: { $implicit: child, level: 1 }"
                />
              }
            }
          </div>
        }
      } @else if (section.kind === 'folder') {
        <!-- Top-level library entry (the canonical case post-refactor). -->
        <ng-container
          *ngTemplateOutlet="folderNode; context: { $implicit: section, level: 0 }"
        />
      } @else if (section.kind === 'subheader') {
        <div class="px-5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-text-muted">{{ section.label }}</div>
      } @else {
        <!-- Smart item or album row at the top level -->
        <div
          class="tree-row mx-2 flex h-7 cursor-pointer items-center gap-2 rounded-md px-3 text-[12px] text-text-main transition-[background] duration-[120ms]"
          [class.selected]="state.selectedSourceId() === section.id"
          (click)="state.selectedSourceId.set(section.id)"
        >
          <maple-icon
            [name]="iconForSmartOrAlbum(section)"
            [size]="13"
            [color]="
              state.selectedSourceId() === section.id
                ? 'var(--color-primary)'
                : 'var(--color-text-muted)'
            "
          />
          <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{{ section.label }}</span>
          @if (section.count != null) {
            <span class="font-mono text-[10px] tabular-nums text-text-muted">{{ section.count | number }}</span>
          }
        </div>
      }
    }

    <!-- Recursive folder-node template -->
    <ng-template #folderNode let-node let-level="level">
      @let isOpen = isFolderOpen(node);
      @let isSelected = state.selectedSourceId() === node.id;
      @let hasLoadedChildren = (node.children?.length ?? 0) > 0;
      @let canExpand = !!node.absPath || hasLoadedChildren;
      @let isLoading = node.childrenStatus === 'loading';
      @let hasError = node.childrenStatus === 'error';

      <div
        class="tree-row mx-2 flex h-7 cursor-pointer items-center gap-2 rounded-md text-[12px] text-text-main transition-[background] duration-[120ms]"
        [class.selected]="isSelected"
        [style.padding-left.px]="10 + level * 14"
        [style.padding-right.px]="12"
        (click)="onFolderClick(node, $event)"
      >
        <!-- Expand/collapse chevron, spinner, or spacer -->
        @if (canExpand) {
          <div class="flex w-3 flex-shrink-0 items-center justify-center" (click)="onChevronClick(node, $event)">
            @if (isLoading) {
              <div class="chevron-spinner h-2 w-2 rounded-full border-[1.5px] border-border" aria-label="Loading"></div>
            } @else if (hasError) {
              <span class="text-[11px] leading-none text-error-text" [title]="node.childrenError">!</span>
            } @else {
              <maple-icon
                [name]="isOpen ? 'chevron-down' : 'chevron-right'"
                [size]="10"
                color="var(--color-text-muted)"
                [strokeWidth]="2"
              />
            }
          </div>
        } @else {
          <div class="w-3 flex-shrink-0"></div>
        }

        <!-- Folder icon -->
        <maple-icon
          [name]="isOpen && hasLoadedChildren ? 'folder-open' : 'folder'"
          [size]="13"
          [color]="isSelected ? 'var(--color-primary)' : 'var(--color-text-muted)'"
        />

        <!-- Name -->
        <span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{{ node.label }}</span>

        <!-- Count -->
        @if (node.count != null) {
          <span class="mr-1 font-mono text-[10px] tabular-nums text-text-muted">{{ node.count }}</span>
        }
      </div>

      <!-- Children (next nesting level) -->
      @if (isOpen && hasLoadedChildren) {
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
    if (node.absPath) {
      // FS-walk path — load this directory's contents into the grid AND
      // attach its subdirs as tree children in one shot. `openSelfHostedSubfolder`
      // handles both via `_attachFsChildren`, so we don't separately call
      // `expandFsFolder` here — that would fire a duplicate `/api/fs/dir`
      // request for the same path because the first call's response hasn't
      // landed yet (childrenStatus is still undefined at click time).
      this.state.openSelfHostedSubfolder(node.absPath, node.id);
      this.state.setFolderOpen(node.id, true);
      return;
    }
    this.state.selectedSourceId.set(node.id);
  }

  onChevronClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    const willOpen = !this.isFolderOpen(node);
    this.state.setFolderOpen(node.id, willOpen);
    if (willOpen && node.absPath && node.childrenStatus === undefined) {
      this.state.expandFsFolder(node);
    }
    if (willOpen && node.absPath && node.childrenStatus === 'error') {
      // Retry on click when previous load failed.
      this.state.expandFsFolder(node);
    }
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
