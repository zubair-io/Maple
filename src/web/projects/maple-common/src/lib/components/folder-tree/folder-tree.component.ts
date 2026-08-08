// Left sidebar — collapsible sections, nested folder tree, smart items, albums.
// Ported from _design-reference/lib/tree.jsx MapleFileTree / FolderNode / TreeSection.
//
// Folder-tree context menu (#2643): right-click, long-press (touch), or the
// keyboard Menu key / Shift+F10 on a folder row opens New Folder / Rename /
// Move to Trash. This file only captures the trigger (which row, where) and
// hands off to `FolderTreeCrudComponent`, which owns the menu, the three
// actions' dialogs, and every folder-CRUD HTTP call. That split matters for
// two reasons (#2705 review):
//   - `FolderTreeCrudComponent` is referenced below only inside an `@defer`
//     block, so it — and everything it imports — code-splits into its own
//     chunk instead of landing in the app's eager main bundle.
//   - Folder CRUD operates on registered filesystem libraries, a
//     Self-Hosted-only concept. `FOLDER_TREE_CRUD_ENABLED` defaults to
//     `false` and only Self-Hosted's composition root turns it on
//     (`folder-tree-crud-capability.ts`), so the row handlers below never
//     even open the menu on Hosted.

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DecimalPipe, NgComponentOutlet, NgTemplateOutlet } from '@angular/common';
import { CdkDrag, CdkDragDrop, CdkDropList, DragDropModule } from '@angular/cdk/drag-drop';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent, MapleIconName } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';
import { selectSidebarEntry } from '../../shells/browse-shell/source-selection';
import { FOLDER_TREE_EXTENSIONS } from './folder-tree-extension';
import { FOLDER_TREE_CRUD_ENABLED } from './folder-tree-crud-capability';
import {
  FolderTreeCrudComponent,
  type FolderCrudMutation,
  type FolderCrudRequest,
} from './folder-tree-crud.component';
import { DRAG_MOVE_CAPABILITY } from '../../drag-move/drag-move-capability';
import { isCopyModifierEvent } from '../../drag-move/drag-move-platform';
import type { AssetDragData } from '../../drag-move/asset-drag-data';

/** Touch long-press → context menu. 500ms matches the platform convention
 * (iOS/Android system long-press threshold); 10px is the move tolerance
 * before a touch reads as a scroll gesture instead of a hold. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

@Component({
  selector: 'app-folder-tree',
  standalone: true,
  imports: [
    MapleIconComponent,
    NgComponentOutlet,
    NgTemplateOutlet,
    DecimalPipe,
    FolderTreeCrudComponent,
    DragDropModule,
  ],
  styleUrl: './folder-tree.component.scss',
  templateUrl: './folder-tree.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeComponent {
  state = inject(LibraryStateService);
  protected readonly extensions = inject(FOLDER_TREE_EXTENSIONS);
  private readonly crudEnabled = inject(FOLDER_TREE_CRUD_ENABLED);
  protected readonly dragMove = inject(DRAG_MOVE_CAPABILITY);

  readonly crudRequest = signal<FolderCrudRequest | null>(null);
  readonly trashPartialWarning = signal<string | null>(null);

  /** Element to return focus to once the crud menu/dialog flow closes
   * (keyboard- or long-press-invoked; a mouse right-click leaves focus
   * wherever it already was). */
  private lastInvoker: HTMLElement | null = null;

  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressStart: { x: number; y: number } | null = null;

  isFolderOpen(node: SidebarEntry): boolean {
    const map = this.state.folderOpen();
    return map[node.id] !== undefined ? map[node.id] : node.open === true;
  }

  onFolderClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    // FS-walk / M2-addressed folders load this directory's contents into the
    // grid AND attach its subdirs as tree children in one shot; smart/album/
    // legacy roots are a plain id select. The shared `selectSidebarEntry`
    // helper mirrors this branch so the phone source-picker drawer (which
    // only has the id, not the node) shares the same selection path (#2280).
    selectSidebarEntry(this.state, node.id);
  }

  onChevronClick(node: SidebarEntry, e: MouseEvent): void {
    e.stopPropagation();
    const willOpen = !this.isFolderOpen(node);
    this.state.setFolderOpen(node.id, willOpen);
    const canExpand = node.absPath || node.id.includes(':');
    if (willOpen && canExpand && node.childrenStatus === undefined) {
      this.state.expandFsFolder(node);
    }
    if (willOpen && canExpand && node.childrenStatus === 'error') {
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

  // ── Drag-move / drag-copy (#2644) ───────────────────────────────────────
  // The CDK mechanics (which rows are `cdkDropList`s, the drag preview, the
  // receiving highlight) live directly here since they're plain UI with no
  // server import — only the actual relocate call, reached through the
  // `DragMoveCapability` token, is Self-Hosted-only. `dropDisabledReason`
  // doubles as the `cdkDropListEnterPredicate`: a node CDK won't let the
  // drag enter never shows the "receiving" highlight, which is how an
  // invalid target (the assets' own current folder, a non-folder row, a
  // legacy `fs:` node) gets rejected visually before drop.

  /** Bound once, not per-row: reads the target node off `drop.data`
   * (`[cdkDropListData]="node"`) and the drag payload off `drag.data`
   * (`[cdkDragData]` on the grid tile), so a single function instance
   * serves every row instead of a fresh closure per template evaluation. */
  readonly dropEnterPredicate = (
    drag: CdkDrag<AssetDragData>,
    drop: CdkDropList<SidebarEntry>,
  ): boolean => {
    const node = drop.data;
    const data = drag.data;
    if (!node || !data) return false;
    return this.dragMove.dropDisabledReason(node, data.sourceFolderId) === null;
  };

  onAssetsDropped(
    event: CdkDragDrop<SidebarEntry, unknown, AssetDragData>,
    node: SidebarEntry,
  ): void {
    const data = event.item.data;
    if (!data || data.assetIds.length === 0) return;
    const mode = isCopyModifierEvent(event.event as MouseEvent) ? 'copy' : 'move';
    this.dragMove.beginMove(data.assetIds, data.sourceFolderId, node, mode);
  }

  // ── Context menu trigger ───────────────────────────────────────────────

  /** Only M2-addressed (`slug:relPath`) folder nodes have a library-id +
   * relative-path pair the CRUD endpoints can address, and only when
   * Self-Hosted's composition root has turned the capability on. */
  private isCrudEligible(node: SidebarEntry): boolean {
    return (
      this.crudEnabled &&
      node.kind === 'folder' &&
      node.id.includes(':') &&
      !node.id.startsWith('fs:')
    );
  }

  onFolderContextMenu(node: SidebarEntry, event: MouseEvent): void {
    if (!this.isCrudEligible(node)) return;
    event.preventDefault();
    event.stopPropagation();
    this.lastInvoker = null; // mouse-invoked — leave focus where it is
    this.crudRequest.set({ node, x: event.clientX, y: event.clientY });
  }

  onRowKeydown(node: SidebarEntry, event: KeyboardEvent): void {
    if (!this.isCrudEligible(node)) return;
    const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
    if (!isMenuKey) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    this.lastInvoker = target;
    const rect = target.getBoundingClientRect();
    this.crudRequest.set({ node, x: rect.left + 12, y: rect.bottom });
  }

  onRowPointerDown(node: SidebarEntry, event: PointerEvent): void {
    if (event.pointerType !== 'touch' || !this.isCrudEligible(node)) return;
    this.longPressStart = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget as HTMLElement;
    const { clientX, clientY } = event;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressStart = null;
      this.lastInvoker = target;
      this.crudRequest.set({ node, x: clientX, y: clientY });
    }, LONG_PRESS_MS);
  }

  onRowPointerMove(event: PointerEvent): void {
    if (!this.longPressStart) return;
    const dx = event.clientX - this.longPressStart.x;
    const dy = event.clientY - this.longPressStart.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) this.cancelLongPress();
  }

  onRowPointerUp(): void {
    this.cancelLongPress();
  }

  onRowPointerCancel(): void {
    this.cancelLongPress();
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressStart = null;
  }

  // ── Crud outcome handling ──────────────────────────────────────────────
  // Deliberately kept here rather than in `FolderTreeCrudComponent`: both
  // lean on `LibraryStateService`, which every app already loads eagerly
  // (it's the shared state facade), so there's no bundle-size reason to push
  // them into the lazy chunk too — and keeping them here means the crud
  // component doesn't need to know how the tree represents "refresh" or
  // "reconcile the current selection."

  onCrudClosed(): void {
    this.crudRequest.set(null);
    this.lastInvoker?.focus();
    this.lastInvoker = null;
  }

  onCrudMutated(mutation: FolderCrudMutation): void {
    this.state.expandFsFolder({ id: mutation.parentId, childrenStatus: undefined });
    if (mutation.kind === 'created') {
      this.state.setFolderOpen(mutation.parentId, true);
      return;
    }
    if (mutation.kind === 'renamed') {
      this.reconcileSelection(mutation.oldId, mutation.newId);
      return;
    }
    this.reconcileSelection(mutation.trashedId, mutation.parentId, { prefixOnly: true });
    if (mutation.partialFailureMessage) {
      this.trashPartialWarning.set(mutation.partialFailureMessage);
    }
  }

  dismissTrashPartialWarning(): void {
    this.trashPartialWarning.set(null);
  }

  /** Repoints `selectedSourceId` when it was the mutated node itself, or a
   * descendant of it, onto the equivalent new address — a rename rewrites
   * the descendant's prefix (`oldId/child` → `newId/child`); a trash falls
   * every descendant back to the parent (`prefixOnly`, no rewritten suffix
   * to fall back to since the folder is gone). */
  private reconcileSelection(
    oldId: string,
    newId: string,
    opts: { prefixOnly?: boolean } = {},
  ): void {
    const selected = this.state.selectedSourceId();
    if (selected === oldId) {
      selectSidebarEntry(this.state, newId);
      return;
    }
    if (selected.startsWith(oldId + '/')) {
      const target = opts.prefixOnly ? newId : newId + selected.slice(oldId.length);
      selectSidebarEntry(this.state, target);
    }
  }
}
