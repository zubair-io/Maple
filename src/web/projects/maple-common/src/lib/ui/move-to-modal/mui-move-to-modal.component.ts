// MuiMoveToModal — Maple UI Organisms (unified-component-catalog.md §4.4).
// Destination tree picker, built from Overlay Shell, Search Bar, Tree Row
// (repeated, indented per depth), and Button. The visible row set is a
// `computed()` over the flat node list: while searching, every name match
// shows flat; otherwise only nodes whose whole ancestor chain is expanded
// are shown.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiSearchBarComponent } from '../search-bar/mui-search-bar.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiTreeRowComponent } from '../tree-row/mui-tree-row.component';

export interface MuiMoveToTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly depth: number;
  readonly hasChildren: boolean;
}

@Component({
  selector: 'mui-move-to-modal',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiOverlayShellComponent,
    MuiSearchBarComponent,
    MuiTextComponent,
    MuiTreeRowComponent,
  ],
  templateUrl: './mui-move-to-modal.component.html',
  styleUrl: './mui-move-to-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiMoveToModalComponent {
  readonly open = input<boolean>(false);
  readonly nodes = input.required<readonly MuiMoveToTreeNode[]>();
  readonly selectedId = model<string | null>(null);

  /** Fires with the chosen destination id when Move is pressed. */
  readonly moveConfirmed = output<string>();
  readonly dismissed = output<void>();

  readonly searchQuery = signal('');
  readonly expandedIds = signal<ReadonlySet<string>>(new Set());

  readonly visibleNodes = computed<readonly MuiMoveToTreeNode[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const all = this.nodes();
    if (query.length > 0) {
      return all.filter((node) => node.name.toLowerCase().includes(query));
    }
    const expanded = this.expandedIds();
    return all.filter((node) => this.isVisible(node, all, expanded));
  });

  toggleExpand(nodeId: string, expand: boolean): void {
    const next = new Set(this.expandedIds());
    expand ? next.add(nodeId) : next.delete(nodeId);
    this.expandedIds.set(next);
  }

  select(nodeId: string): void {
    this.selectedId.set(nodeId);
  }

  confirmMove(): void {
    const destination = this.selectedId();
    if (destination === null) return;
    this.moveConfirmed.emit(destination);
  }

  private isVisible(
    node: MuiMoveToTreeNode,
    all: readonly MuiMoveToTreeNode[],
    expanded: ReadonlySet<string>,
  ): boolean {
    let current: MuiMoveToTreeNode | undefined = node;
    while (current && current.parentId !== null) {
      if (!expanded.has(current.parentId)) return false;
      current = all.find((candidate) => candidate.id === current!.parentId);
    }
    return true;
  }
}
