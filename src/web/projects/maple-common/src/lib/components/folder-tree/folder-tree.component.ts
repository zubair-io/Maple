// Left sidebar — collapsible sections, nested folder tree, smart items, albums.
// Ported from _design-reference/lib/tree.jsx MapleFileTree / FolderNode / TreeSection.
//
// Folder-tree context menu (#2643): right-click, long-press (touch), or the
// keyboard Menu key / Shift+F10 on a folder row opens New Folder / Rename /
// Move to Trash. Every action calls the API and then refreshes the affected
// node's children from the server rather than mutating `sidebarTree` locally
// — the tree never guesses at a shape the server hasn't confirmed.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DecimalPipe, NgComponentOutlet, NgTemplateOutlet } from '@angular/common';
import { LibraryStateService } from '../../state/library-state.service';
import { MapleIconComponent, MapleIconName } from '../../icons/maple-icon.component';
import { SidebarEntry } from '../../models/folder';
import { selectSidebarEntry } from '../../shells/browse-shell/source-selection';
import { FOLDER_TREE_EXTENSIONS } from './folder-tree-extension';
import { FolderCrudService } from '../../api/folder-crud.service';
import {
  childAddress,
  formatAddress,
  parentAddress,
  parseAddress,
} from '../../addressing/maple-address';
import { FolderContextMenuComponent, FolderMenuItem } from './folder-context-menu.component';
import { FolderNewFolderDialogComponent } from './folder-new-folder-dialog.component';
import { FolderTrashConfirmDialogComponent } from './folder-trash-confirm-dialog.component';
import { validateFolderNameDraft } from './folder-name-validation';

/** Touch long-press → context menu. 500ms matches the platform convention
 * (iOS/Android system long-press threshold); 10px is the move tolerance
 * before a touch reads as a scroll gesture instead of a hold. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

function extractHttpError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const detail = (err.error as { error?: string } | null)?.error;
    return detail ?? err.message ?? 'Unknown error';
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

@Component({
  selector: 'app-folder-tree',
  standalone: true,
  imports: [
    MapleIconComponent,
    NgComponentOutlet,
    NgTemplateOutlet,
    DecimalPipe,
    FolderContextMenuComponent,
    FolderNewFolderDialogComponent,
    FolderTrashConfirmDialogComponent,
  ],
  styleUrl: './folder-tree.component.scss',
  templateUrl: './folder-tree.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeComponent {
  state = inject(LibraryStateService);
  protected readonly extensions = inject(FOLDER_TREE_EXTENSIONS);
  private readonly crud = inject(FolderCrudService);

  // ── Context menu ───────────────────────────────────────────────────────
  readonly contextMenuNode = signal<SidebarEntry | null>(null);
  readonly contextMenuPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly contextMenuItems = computed<FolderMenuItem[]>(() => {
    const node = this.contextMenuNode();
    return node ? this.buildMenuItems(node) : [];
  });
  /** Element to return focus to when the menu or a dialog it opened closes
   * (keyboard-invoked or long-press invoked; a mouse right-click leaves
   * focus wherever it already was, which is fine). */
  private lastInvoker: HTMLElement | null = null;

  // ── Inline rename ──────────────────────────────────────────────────────
  readonly renamingNodeId = signal<string | null>(null);
  readonly renameDraft = signal('');
  readonly renameError = signal<string | null>(null);
  readonly renameValidation = computed(() => validateFolderNameDraft(this.renameDraft()));

  // ── New Folder dialog ──────────────────────────────────────────────────
  readonly newFolderParent = signal<SidebarEntry | null>(null);
  readonly newFolderError = signal<string | null>(null);

  // ── Move to Trash confirm ──────────────────────────────────────────────
  readonly trashTarget = signal<SidebarEntry | null>(null);
  readonly trashError = signal<string | null>(null);
  readonly trashPartialWarning = signal<string | null>(null);

  readonly crudBusy = signal(false);

  // ── Long-press (touch) state ───────────────────────────────────────────
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressStart: { x: number; y: number } | null = null;

  constructor() {
    // Autofocus + select the inline rename `<input>` when it appears. A
    // recursive `ng-template` makes `@ViewChild` awkward to key correctly
    // (only one row is ever renaming at a time, so a single global-ish
    // selector is simpler and just as correct).
    effect(() => {
      if (this.renamingNodeId() === null) return;
      queueMicrotask(() => {
        const el = document.querySelector<HTMLInputElement>('.folder-rename-input');
        el?.focus();
        el?.select();
      });
    });
  }

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

  // ── Context menu wiring ────────────────────────────────────────────────

  /** Only M2-addressed (`slug:relPath`) folder nodes have a library-id +
   * relative-path pair the CRUD endpoints can address — legacy `fs:`
   * entries and non-folder rows never reach this (the menu isn't bound to
   * them in the template), but a defensive check here keeps the handler
   * safe if that ever changes. */
  private isCrudEligible(node: SidebarEntry): boolean {
    return node.kind === 'folder' && node.id.includes(':') && !node.id.startsWith('fs:');
  }

  onFolderContextMenu(node: SidebarEntry, event: MouseEvent): void {
    if (!this.isCrudEligible(node)) return;
    event.preventDefault();
    event.stopPropagation();
    this.lastInvoker = null; // mouse-invoked — leave focus where it is
    this.openContextMenu(node, event.clientX, event.clientY);
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
    this.openContextMenu(node, rect.left + 12, rect.bottom);
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
      this.openContextMenu(node, clientX, clientY);
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

  private openContextMenu(node: SidebarEntry, x: number, y: number): void {
    this.contextMenuNode.set(node);
    this.contextMenuPos.set({ x, y });
  }

  private buildMenuItems(node: SidebarEntry): FolderMenuItem[] {
    const isRoot = parseAddress(node.id).relPath === '';
    return [
      { id: 'new-folder', label: 'New Folder', icon: 'folder-plus' },
      {
        id: 'rename',
        label: 'Rename…',
        icon: 'edit',
        disabled: isRoot,
        disabledReason: isRoot
          ? "The library root can't be renamed here — remove and re-add the folder instead."
          : undefined,
      },
      {
        id: 'trash',
        label: 'Move to Trash',
        icon: 'trash',
        destructive: true,
        disabled: isRoot,
        disabledReason: isRoot
          ? "The library root can't be trashed — remove it from the library instead."
          : undefined,
      },
    ];
  }

  onContextMenuAction(actionId: string): void {
    const node = this.contextMenuNode();
    this.contextMenuNode.set(null);
    if (!node) return;
    if (actionId === 'new-folder') this.beginNewFolder(node);
    else if (actionId === 'rename') this.beginRename(node);
    else if (actionId === 'trash') this.beginTrash(node);
    else this.returnFocus();
  }

  onContextMenuClosed(): void {
    this.contextMenuNode.set(null);
    this.returnFocus();
  }

  private returnFocus(): void {
    this.lastInvoker?.focus();
    this.lastInvoker = null;
  }

  /** Resolve the registered library (mongo id + path) that owns a
   * `slug:relPath` node id. Returns `null` when the library hasn't loaded
   * yet (shouldn't happen for a node the tree is already showing, but the
   * caller surfaces this rather than assuming). */
  private resolveLibraryId(node: SidebarEntry): string | null {
    const addr = parseAddress(node.id);
    const folder = this.state
      .registeredFolders()
      .find((f) => f.slug === addr.slug || f.id === addr.slug);
    return folder?.id ?? null;
  }

  /** Re-fetch a node's children from the server — the "refresh from source
   * of truth" every CRUD action ends with, instead of splicing a guessed
   * shape into `sidebarTree` locally. */
  private refreshChildren(nodeId: string): void {
    this.state.expandFsFolder({ id: nodeId, childrenStatus: undefined });
  }

  // ── New Folder ─────────────────────────────────────────────────────────

  private beginNewFolder(node: SidebarEntry): void {
    this.newFolderParent.set(node);
    this.newFolderError.set(null);
  }

  onNewFolderDismiss(): void {
    this.newFolderParent.set(null);
    this.newFolderError.set(null);
    this.returnFocus();
  }

  onNewFolderCreate(name: string): void {
    const parent = this.newFolderParent();
    if (!parent) return;
    const libraryId = this.resolveLibraryId(parent);
    if (!libraryId) {
      this.newFolderError.set('Could not resolve this library — try reloading.');
      return;
    }
    const targetRelPath = childAddress(parseAddress(parent.id), name).relPath;
    this.crudBusy.set(true);
    this.crud.mkdir(libraryId, targetRelPath).subscribe({
      next: () => {
        this.crudBusy.set(false);
        this.newFolderParent.set(null);
        this.state.setFolderOpen(parent.id, true);
        this.refreshChildren(parent.id);
        this.returnFocus();
      },
      error: (err: unknown) => {
        this.crudBusy.set(false);
        this.newFolderError.set(extractHttpError(err));
      },
    });
  }

  // ── Rename ─────────────────────────────────────────────────────────────

  private beginRename(node: SidebarEntry): void {
    this.renamingNodeId.set(node.id);
    this.renameDraft.set(node.label);
    this.renameError.set(null);
  }

  onRenameInput(value: string): void {
    this.renameDraft.set(value);
  }

  cancelRename(): void {
    this.renamingNodeId.set(null);
    this.renameError.set(null);
    this.returnFocus();
  }

  confirmRename(node: SidebarEntry): void {
    const name = this.renameDraft().trim();
    if (this.renameValidation() !== null) return;
    if (name === node.label) {
      this.cancelRename();
      return;
    }
    const libraryId = this.resolveLibraryId(node);
    const addr = parseAddress(node.id);
    const parent = parentAddress(addr);
    if (!libraryId || !parent) {
      this.renameError.set('Could not resolve this library — try reloading.');
      return;
    }
    const targetAddr = childAddress(parent, name);
    this.crudBusy.set(true);
    this.crud.move(libraryId, addr.relPath, targetAddr.relPath).subscribe({
      next: () => {
        this.crudBusy.set(false);
        this.renamingNodeId.set(null);
        const parentId = formatAddress(parent);
        this.refreshChildren(parentId);
        this.reconcileSelectionAfterRename(node.id, formatAddress(targetAddr));
        this.returnFocus();
      },
      error: (err: unknown) => {
        this.crudBusy.set(false);
        this.renameError.set(extractHttpError(err));
      },
    });
  }

  private reconcileSelectionAfterRename(oldId: string, newId: string): void {
    if (this.state.selectedSourceId() !== oldId) return;
    selectSidebarEntry(this.state, newId);
  }

  // ── Move to Trash ──────────────────────────────────────────────────────

  private beginTrash(node: SidebarEntry): void {
    this.trashTarget.set(node);
    this.trashError.set(null);
  }

  onTrashDismiss(): void {
    this.trashTarget.set(null);
    this.trashError.set(null);
    this.returnFocus();
  }

  onTrashConfirm(): void {
    const node = this.trashTarget();
    if (!node) return;
    const libraryId = this.resolveLibraryId(node);
    const addr = parseAddress(node.id);
    const parent = parentAddress(addr);
    if (!libraryId || !parent) {
      this.trashError.set('Could not resolve this library — try reloading.');
      return;
    }
    this.crudBusy.set(true);
    this.crud.trashFolder(libraryId, addr.relPath).subscribe({
      next: (summary) => {
        this.crudBusy.set(false);
        this.trashTarget.set(null);
        this.trashPartialWarning.set(
          summary.failed > 0
            ? `${summary.failed} of ${summary.total} item(s) in "${node.label}" could not be moved to Trash.`
            : null,
        );
        const parentId = formatAddress(parent);
        this.refreshChildren(parentId);
        this.reconcileSelectionAfterTrash(node.id, parentId);
        this.returnFocus();
      },
      error: (err: unknown) => {
        this.crudBusy.set(false);
        this.trashError.set(extractHttpError(err));
      },
    });
  }

  dismissTrashPartialWarning(): void {
    this.trashPartialWarning.set(null);
  }

  private reconcileSelectionAfterTrash(trashedId: string, fallbackParentId: string): void {
    const selected = this.state.selectedSourceId();
    if (selected !== trashedId && !selected.startsWith(trashedId + '/')) return;
    selectSidebarEntry(this.state, fallbackParentId);
  }
}
