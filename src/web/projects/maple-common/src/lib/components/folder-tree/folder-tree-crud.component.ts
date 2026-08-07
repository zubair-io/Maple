// FolderTreeCrudComponent — orchestrates the folder-tree context menu, its
// three actions' dialogs, and the `FolderCrudService` HTTP calls (#2643,
// restructured per the #2705 review).
//
// Deliberately its own component rather than living inline in
// `folder-tree.component.ts`: `folder-tree.component.ts` references this
// component ONLY inside an `@defer` block, so Angular code-splits this file
// — and everything it imports (`FolderContextMenuComponent`, the three
// dialogs, `FolderCrudService`) — into its own chunk instead of the app's
// main bundle. Folder CRUD is a Self-Hosted-only capability (it operates on
// registered filesystem libraries); Hosted never triggers the `@defer`
// (`FOLDER_TREE_CRUD_ENABLED` is `false` there — see
// `folder-tree-crud-capability.ts`), but the chunk split holds regardless of
// which app is building, which is what actually keeps this out of the
// Hosted main-bundle byte ratchet (`check-hosted-capability-boundary.mjs`).
//
// One instance handles ONE `request` (right-click / long-press / keyboard
// menu-key on one row) end to end: menu → an action → its dialog → the HTTP
// call → emit the outcome. The parent tears this component down (by nulling
// the id that gates the surrounding `@if`) once `closed` fires, so a fresh
// instance with fresh state is what handles the next request — no
// visibility-toggle plumbing, matching the individual dialogs' own
// "mount fresh" convention.

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { LibraryStateService } from '../../state/library-state.service';
import { SidebarEntry } from '../../models/folder';
import { FolderCrudService } from '../../api/folder-crud.service';
import { childAddress, parentAddress, parseAddress } from '../../addressing/maple-address';
import { FolderContextMenuComponent, FolderMenuItem } from './folder-context-menu.component';
import { FolderNewFolderDialogComponent } from './folder-new-folder-dialog.component';
import { FolderRenameDialogComponent } from './folder-rename-dialog.component';
import { FolderTrashConfirmDialogComponent } from './folder-trash-confirm-dialog.component';

export interface FolderCrudRequest {
  node: SidebarEntry;
  x: number;
  y: number;
}

/** What happened, so the (eager) parent can refresh the right tree node and
 * reconcile the grid selection — both of those lean on `LibraryStateService`,
 * which is already part of every app's eager bundle, so there's no bundle
 * gain in duplicating that plumbing in here too. */
export type FolderCrudMutation =
  | { kind: 'created'; parentId: string }
  | { kind: 'renamed'; oldId: string; newId: string; parentId: string }
  | { kind: 'trashed'; trashedId: string; parentId: string; partialFailureMessage: string | null };

function extractHttpError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const detail = (err.error as { error?: string } | null)?.error;
    return detail ?? err.message ?? 'Unknown error';
  }
  return err instanceof Error ? err.message : 'Unknown error';
}

type ActiveDialog = 'new-folder' | 'rename' | 'trash' | null;

@Component({
  selector: 'app-folder-tree-crud',
  standalone: true,
  imports: [
    FolderContextMenuComponent,
    FolderNewFolderDialogComponent,
    FolderRenameDialogComponent,
    FolderTrashConfirmDialogComponent,
  ],
  templateUrl: './folder-tree-crud.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeCrudComponent {
  private readonly state = inject(LibraryStateService);
  private readonly crud = inject(FolderCrudService);

  readonly request = input.required<FolderCrudRequest>();

  readonly closed = output<void>();
  readonly mutated = output<FolderCrudMutation>();

  readonly activeDialog = signal<ActiveDialog>(null);
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);

  private readonly isRoot = computed(() => parseAddress(this.request().node.id).relPath === '');

  readonly menuItems = computed<FolderMenuItem[]>(() => {
    const rootDisabled = this.isRoot();
    return [
      { id: 'new-folder', label: 'New Folder', icon: 'folder-plus' },
      {
        id: 'rename',
        label: 'Rename…',
        icon: 'edit',
        disabled: rootDisabled,
        disabledReason: rootDisabled
          ? "The library root can't be renamed here — remove and re-add the folder instead."
          : undefined,
      },
      {
        id: 'trash',
        label: 'Move to Trash',
        icon: 'trash',
        destructive: true,
        disabled: rootDisabled,
        disabledReason: rootDisabled
          ? "The library root can't be trashed here — remove it from the library instead."
          : undefined,
      },
    ];
  });

  onMenuAction(actionId: string): void {
    if (actionId === 'new-folder' || actionId === 'rename' || actionId === 'trash') {
      this.errorMessage.set(null);
      this.activeDialog.set(actionId);
      return;
    }
    this.closed.emit();
  }

  onMenuClosed(): void {
    this.closed.emit();
  }

  onDialogDismiss(): void {
    this.closed.emit();
  }

  private resolveLibraryId(node: SidebarEntry): string | null {
    const addr = parseAddress(node.id);
    const folder = this.state
      .registeredFolders()
      .find((f) => f.slug === addr.slug || f.id === addr.slug);
    return folder?.id ?? null;
  }

  // ── New Folder ─────────────────────────────────────────────────────────

  onNewFolderCreate(name: string): void {
    if (this.busy()) return;
    const node = this.request().node;
    const libraryId = this.resolveLibraryId(node);
    if (!libraryId) {
      this.errorMessage.set('Could not resolve this library — try reloading.');
      return;
    }
    const targetRelPath = childAddress(parseAddress(node.id), name).relPath;
    this.errorMessage.set(null);
    this.busy.set(true);
    this.crud.mkdir(libraryId, targetRelPath).subscribe({
      next: () => {
        this.busy.set(false);
        this.mutated.emit({ kind: 'created', parentId: node.id });
        this.closed.emit();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.errorMessage.set(extractHttpError(err));
      },
    });
  }

  // ── Rename ─────────────────────────────────────────────────────────────

  onRenameConfirm(name: string): void {
    if (this.busy()) return;
    const node = this.request().node;
    const libraryId = this.resolveLibraryId(node);
    const addr = parseAddress(node.id);
    const parent = parentAddress(addr);
    if (!libraryId || !parent) {
      this.errorMessage.set('Could not resolve this library — try reloading.');
      return;
    }
    const targetAddr = childAddress(parent, name);
    this.errorMessage.set(null);
    this.busy.set(true);
    this.crud.move(libraryId, addr.relPath, targetAddr.relPath).subscribe({
      next: () => {
        this.busy.set(false);
        this.mutated.emit({
          kind: 'renamed',
          oldId: node.id,
          newId: `${targetAddr.slug}:${targetAddr.relPath}`,
          parentId: `${parent.slug}:${parent.relPath}`,
        });
        this.closed.emit();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.errorMessage.set(extractHttpError(err));
      },
    });
  }

  // ── Move to Trash ──────────────────────────────────────────────────────

  onTrashConfirm(): void {
    if (this.busy()) return;
    const node = this.request().node;
    const libraryId = this.resolveLibraryId(node);
    const addr = parseAddress(node.id);
    const parent = parentAddress(addr);
    if (!libraryId || !parent) {
      this.errorMessage.set('Could not resolve this library — try reloading.');
      return;
    }
    this.errorMessage.set(null);
    this.busy.set(true);
    this.crud.trashFolder(libraryId, addr.relPath).subscribe({
      next: (summary) => {
        this.busy.set(false);
        this.mutated.emit({
          kind: 'trashed',
          trashedId: node.id,
          parentId: `${parent.slug}:${parent.relPath}`,
          partialFailureMessage:
            summary.failed > 0
              ? `${summary.failed} of ${summary.total} item(s) in "${node.label}" could not be moved to Trash.`
              : null,
        });
        this.closed.emit();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.errorMessage.set(extractHttpError(err));
      },
    });
  }
}
