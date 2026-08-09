// FolderTreeNodeComponent — one row of the recursive folder tree, plus its
// children (#2749 review: extracted out of `folder-tree.component.html`'s
// `#folderNode` `ng-template`, which was the majority of that file's
// fallow-audit-web CRITICAL template-complexity finding — 34 cyclomatic /
// 60 cognitive across the whole file, dominated by this one recursive
// block. A real recursive standalone component (self-referenced via
// `forwardRef`) carries its own row rendering, expand/collapse, drag-drop,
// and context-menu-trigger logic — leaving `folder-tree.component.ts` with
// only the top-level section dispatch and the crud-dialog/trash-partial-
// warning chrome that must stay at the top level (the crud dialog and its
// "return focus to the invoker" behavior are shared across every row, so
// they can't live per-row).
//
// Per-row concerns that stayed on `FolderTreeComponent` before (chevron
// expand, click-to-select, drag-drop, long-press/keyboard context-menu
// trigger) all move down into this component, since none of them need
// anything the PARENT alone knows. The one exception is the actual crud
// menu/dialog: this component only EMITS `crudRequested` with the request
// (node, x, y) and the triggering element (for keyboard/long-press focus
// restore on close) — `FolderTreeComponent` still owns `crudRequest`,
// `FolderTreeCrudComponent`, and `lastInvoker`, because those are shared
// singleton state across every row, not per-row state.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  inject,
  input,
  output,
} from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, DragDropModule } from '@angular/cdk/drag-drop';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';
import { selectSidebarEntry } from '../../shells/browse-shell/source-selection';
import { FOLDER_TREE_CRUD_ENABLED } from './folder-tree-crud-capability';
import type { FolderCrudRequest } from './folder-tree-crud.component';
import { DRAG_MOVE_CAPABILITY } from '../../drag-move/drag-move-capability';
import { isCopyModifierEvent } from '../../drag-move/drag-move-platform';
import type { AssetDragData } from '../../drag-move/asset-drag-data';
import { FolderTreeExpandIconComponent } from './folder-tree-expand-icon.component';

/** Touch long-press → context menu. Same constants
 * `folder-tree.component.ts` used before this extraction. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export interface FolderCrudRequestEvent {
  request: FolderCrudRequest;
  /** Element to return focus to once the crud menu/dialog flow closes —
   * `null` for a mouse-invoked (right-click) request, which leaves focus
   * wherever it already was. */
  invoker: HTMLElement | null;
}

@Component({
  selector: 'app-folder-tree-node',
  standalone: true,
  imports: [
    MapleIconComponent,
    DragDropModule,
    FolderTreeExpandIconComponent,
    forwardRef(() => FolderTreeNodeComponent),
  ],
  templateUrl: './folder-tree-node.component.html',
  styleUrl: './folder-tree-node.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeNodeComponent {
  private readonly state = inject(LibraryStateService);
  private readonly crudEnabled = inject(FOLDER_TREE_CRUD_ENABLED);
  protected readonly dragMove = inject(DRAG_MOVE_CAPABILITY);

  readonly node = input.required<SidebarEntry>();
  readonly level = input(0);

  readonly crudRequested = output<FolderCrudRequestEvent>();

  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressStart: { x: number; y: number } | null = null;

  protected readonly isOpen = computed(() => {
    const node = this.node();
    const map = this.state.folderOpen();
    return map[node.id] !== undefined ? map[node.id] : node.open === true;
  });
  protected readonly isSelected = computed(() => this.state.selectedSourceId() === this.node().id);
  protected readonly hasLoadedChildren = computed(() => (this.node().children?.length ?? 0) > 0);
  protected readonly canExpand = computed(() => !!this.node().absPath || this.hasLoadedChildren());
  protected readonly isLoading = computed(() => this.node().childrenStatus === 'loading');
  protected readonly hasError = computed(() => this.node().childrenStatus === 'error');
  /** Pre-filtered to `kind === 'folder'` so the template's recursion loop
   * is a flat `@for` with no per-child `@if` nested inside it — trims one
   * level of template nesting (#2749 review, fallow-audit-web complexity
   * finding: nesting depth weighs heavily on cognitive complexity). */
  protected readonly folderChildren = computed(
    () => (this.node().children ?? []).filter((c) => c.kind === 'folder') as SidebarEntry[],
  );

  // ── Selection / expand ──────────────────────────────────────────────────

  onFolderClick(e: MouseEvent): void {
    e.stopPropagation();
    // FS-walk / M2-addressed folders load this directory's contents into the
    // grid AND attach its subdirs as tree children in one shot; smart/album/
    // legacy roots are a plain id select. The shared `selectSidebarEntry`
    // helper mirrors this branch so the phone source-picker drawer (which
    // only has the id, not the node) shares the same selection path (#2280).
    selectSidebarEntry(this.state, this.node().id);
  }

  // Propagation is stopped inside `FolderTreeExpandIconComponent.onClick`
  // (a child component now — the native click still bubbles through the
  // real DOM regardless of Angular component boundaries) before it emits
  // `toggle`, so this handler no longer needs the event itself.
  onChevronClick(): void {
    const node = this.node();
    const willOpen = !this.isOpen();
    this.state.setFolderOpen(node.id, willOpen);
    const canExpandFs = node.absPath || node.id.includes(':');
    if (willOpen && canExpandFs && node.childrenStatus === undefined) {
      this.state.expandFsFolder(node);
    }
    if (willOpen && canExpandFs && node.childrenStatus === 'error') {
      // Retry on click when previous load failed.
      this.state.expandFsFolder(node);
    }
  }

  // ── Drag-move / drag-copy (#2644) ───────────────────────────────────────

  readonly dropEnterPredicate = (
    drag: CdkDrag<AssetDragData>,
    drop: CdkDropList<SidebarEntry>,
  ): boolean => {
    const node = drop.data;
    const data = drag.data;
    if (!node || !data) return false;
    return this.dragMove.dropDisabledReason(node, data.sourceFolderId) === null;
  };

  onAssetsDropped(event: CdkDragDrop<SidebarEntry, unknown, AssetDragData>): void {
    const data = event.item.data;
    if (!data || data.assetIds.length === 0) return;
    const mode = isCopyModifierEvent(event.event as MouseEvent) ? 'copy' : 'move';
    this.dragMove.beginMove(data.assetIds, data.sourceFolderId, this.node(), mode);
  }

  // ── Context menu trigger ───────────────────────────────────────────────
  // Only M2-addressed (`slug:relPath`) folder nodes have a library-id +
  // relative-path pair the CRUD endpoints can address, and only when
  // Self-Hosted's composition root has turned the capability on.

  private isCrudEligible(): boolean {
    const node = this.node();
    return (
      this.crudEnabled &&
      node.kind === 'folder' &&
      node.id.includes(':') &&
      !node.id.startsWith('fs:')
    );
  }

  onContextMenu(event: MouseEvent): void {
    if (!this.isCrudEligible()) return;
    event.preventDefault();
    event.stopPropagation();
    this.crudRequested.emit({
      request: { node: this.node(), x: event.clientX, y: event.clientY },
      invoker: null, // mouse-invoked — leave focus where it is
    });
  }

  onRowKeydown(event: KeyboardEvent): void {
    if (!this.isCrudEligible()) return;
    const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
    if (!isMenuKey) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    this.crudRequested.emit({
      request: { node: this.node(), x: rect.left + 12, y: rect.bottom },
      invoker: target,
    });
  }

  onRowPointerDown(event: PointerEvent): void {
    if (event.pointerType !== 'touch' || !this.isCrudEligible()) return;
    this.longPressStart = { x: event.clientX, y: event.clientY };
    const target = event.currentTarget as HTMLElement;
    const { clientX, clientY } = event;
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      this.longPressStart = null;
      this.crudRequested.emit({
        request: { node: this.node(), x: clientX, y: clientY },
        invoker: target,
      });
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
}
