// MoveToTreePickerComponent — the recursive folder-tree row rendering
// `MoveToDialogComponent` (#2644) used to own inline. Split out (#2644
// review — fallow-audit-web flagged the combined dialog+tree template at
// 14 cyclomatic / 17 cognitive / 76 lines, the same "extract the
// self-contained recursive/list piece" move `batch-rename-preview-list
// .component.ts` made off `BatchRenameDialogComponent` in the #2640 round).
//
// Self-referencing: renders one level of `nodes()`, and — for whichever
// node is open and has folder children — an `app-move-to-tree-picker`
// instance of itself one level deeper. Each instance owns its own
// `openNodeIds` (expand/collapse only ever applies to the rows THIS
// instance renders); `select` bubbles a chosen leaf all the way up to
// `MoveToDialogComponent` regardless of which depth it was clicked at.

import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import type { SidebarEntry } from '../models/folder';
import { DRAG_MOVE_CAPABILITY } from './drag-move-capability';

@Component({
  selector: 'app-move-to-tree-picker',
  standalone: true,
  imports: [MoveToTreePickerComponent],
  templateUrl: './move-to-tree-picker.component.html',
  styleUrl: './move-to-tree-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveToTreePickerComponent {
  readonly nodes = input.required<SidebarEntry[]>();
  readonly level = input<number>(0);
  readonly selectedId = input<string | null>(null);
  readonly sourceFolderId = input.required<string>();

  /** Bubbles the chosen node up to the dialog, from whatever depth/instance
   * it was clicked at — a nested instance's own `select` output is wired
   * straight through in the template rather than re-emitted via a handler,
   * since there's nothing to transform. */
  readonly select = output<SidebarEntry>();

  private readonly state = inject(LibraryStateService);
  private readonly dragMove = inject(DRAG_MOVE_CAPABILITY);

  protected readonly openNodeIds = signal<Set<string>>(new Set());

  protected hasChildren(node: SidebarEntry): boolean {
    return (node.children?.length ?? 0) > 0;
  }

  protected canExpand(node: SidebarEntry): boolean {
    return !!node.absPath || this.hasChildren(node);
  }

  protected isOpen(node: SidebarEntry): boolean {
    return this.openNodeIds().has(node.id);
  }

  protected toggleOpen(node: SidebarEntry): void {
    const willOpen = !this.isOpen(node);
    this.openNodeIds.update((prev) => {
      const next = new Set(prev);
      willOpen ? next.add(node.id) : next.delete(node.id);
      return next;
    });
    if (willOpen && this.canExpand(node) && node.childrenStatus === undefined) {
      this.state.expandFsFolder(node);
    }
  }

  /** Why `node` can't be picked as a destination, or `null` when it can —
   * rendered both as a hover `title` and, via `aria-describedby` on the
   * row (in the template), to keyboard/AT users who can't hover. */
  protected disabledReasonFor(node: SidebarEntry): string | null {
    return this.dragMove.dropDisabledReason(node, this.sourceFolderId());
  }

  /** Element id for a row's hidden rejection-reason text — sanitized since
   * `node.id` (`slug:relPath`) carries characters that are valid in an
   * HTML `id` but awkward to eyeball in the DOM inspector. Always returns
   * an id (never conditional) so the template can bind `aria-describedby`
   * unconditionally — an eligible row's element just holds empty text. */
  protected reasonElementId(node: SidebarEntry): string {
    return `mtd-reason-${node.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  /** `title` for a row — empty (not `disabledReasonFor(node) ?? ''`
   * inline) so the template has one less branch to evaluate per row. */
  protected titleFor(node: SidebarEntry): string {
    return this.disabledReasonFor(node) ?? '';
  }

  protected childFolders(node: SidebarEntry): SidebarEntry[] {
    return (node.children ?? []).filter((child) => child.kind === 'folder');
  }

  /** Whether `node`'s children block should render — combines `isOpen` +
   * `hasChildren` in one place so the template's `@if` doesn't also carry
   * a `&&` (#2644 review: kept template-level branching to the minimum
   * `@for`/`@if` count fallow-audit-web's template-complexity gate counts). */
  protected showChildren(node: SidebarEntry): boolean {
    return this.isOpen(node) && this.hasChildren(node);
  }

  protected onRowClick(node: SidebarEntry): void {
    if (this.disabledReasonFor(node)) return;
    this.select.emit(node);
  }
}
