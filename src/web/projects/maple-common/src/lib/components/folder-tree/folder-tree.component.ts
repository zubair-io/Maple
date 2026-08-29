// Left sidebar — collapsible sections, nested folder tree, smart items, albums.
// Ported from _design-reference/lib/tree.jsx MapleFileTree / FolderNode / TreeSection.
//
// Folder-tree context menu (#2643): right-click, long-press (touch), or the
// keyboard Menu key / Shift+F10 on a folder row opens New Folder / Rename /
// Move to Trash. Per-row detection of all three triggers, plus row
// rendering/expand/drag-drop, lives in `FolderTreeNodeComponent`; the menu
// itself, its three dialogs, and every folder-CRUD HTTP call live in
// `FolderTreeCrudComponent`, mounted (behind an `@defer`) from
// `FolderTreeFooterComponent` (#2749 review — both extracted out of this
// file's markup to fix a fallow-audit-web template-complexity finding).
// This file only owns the shared `crudRequest`/`lastInvoker` state and
// relays `crudRequested` events from whichever row emitted them — see
// `FolderTreeFooterComponent`'s module doc for why the `@defer` boundary
// (#2705 review) lives there now instead of here.
//   - Folder CRUD operates on registered filesystem libraries, a
//     Self-Hosted-only concept. `FOLDER_TREE_CRUD_ENABLED` defaults to
//     `false` and only Self-Hosted's composition root turns it on
//     (`folder-tree-crud-capability.ts`), so `FolderTreeNodeComponent`'s
//     row handlers never even open the menu on Hosted.

import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { LibraryStateService } from '../../state/library-state.service';
import { AuthService } from '../../auth/auth.service';
import { selectSidebarEntry } from '../../shells/browse-shell/source-selection';
import { FOLDER_TREE_EXTENSIONS } from './folder-tree-extension';
import type { FolderCrudMutation, FolderCrudRequest } from './folder-tree-crud.component';
import type { FolderCrudRequestEvent } from './folder-tree-node.component';
import { FolderTreeLegacySectionComponent } from './folder-tree-legacy-section.component';
import { FolderTreeSmartRowComponent } from './folder-tree-smart-row.component';
import { FolderTreeLibraryRootComponent } from './folder-tree-library-root.component';
import { FolderTreeFooterComponent } from './folder-tree-footer.component';
import { TRASH_CAPABILITY } from '../../trash/trash-capability';

@Component({
  selector: 'app-folder-tree',
  standalone: true,
  imports: [
    NgComponentOutlet,
    FolderTreeLegacySectionComponent,
    FolderTreeSmartRowComponent,
    FolderTreeLibraryRootComponent,
    FolderTreeFooterComponent,
  ],
  styleUrl: './folder-tree.component.scss',
  host: {
    class:
      'block w-full h-full box-border overflow-y-auto pb-3 border-r-[0.5px] border-border bg-sidebar',
  },
  templateUrl: './folder-tree.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeComponent {
  state = inject(LibraryStateService);
  /** Restricted members (#2893) see no Library tree — Timeline/Map only. */
  protected readonly auth = inject(AuthService);
  protected readonly extensions = inject(FOLDER_TREE_EXTENSIONS);
  protected readonly trash = inject(TRASH_CAPABILITY);

  readonly crudRequest = signal<FolderCrudRequest | null>(null);
  readonly trashPartialWarning = signal<string | null>(null);

  /** Element to return focus to once the crud menu/dialog flow closes
   * (keyboard- or long-press-invoked; a mouse right-click leaves focus
   * wherever it already was). Set from whichever `FolderTreeNodeComponent`
   * row emitted the request — see `onCrudRequested`. */
  private lastInvoker: HTMLElement | null = null;

  constructor() {
    // Warm the sidebar Trash badge for every registered library root once
    // Trash is available — cheap (one small paged request per library) and
    // idempotent (`ensureCountLoaded` no-ops once a library's count is
    // cached), so re-running on every `registeredFolders()` change is safe.
    effect(() => {
      if (!this.trash.available()) return;
      // No tree, no Trash badges — and the per-library trash listing is
      // file-access-gated server-side anyway (#2893).
      if (!this.auth.canBrowseFiles) return;
      for (const folder of this.state.registeredFolders()) {
        this.trash.ensureCountLoaded(folder.id);
      }
    });
  }

  // ── Context menu trigger (relayed from FolderTreeNodeComponent) ─────────

  onCrudRequested(event: FolderCrudRequestEvent): void {
    this.lastInvoker = event.invoker;
    this.crudRequest.set(event.request);
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
