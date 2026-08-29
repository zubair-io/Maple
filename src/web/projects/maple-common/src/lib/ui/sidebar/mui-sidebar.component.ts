// MuiSidebar — the Maple UI design-system Sidebar organism
// (unified-component-catalog.md §4.2; Built from: Tree Row, Toolbar,
// Collapsible, Context Menu, Empty State). Hierarchical source/page tree:
// labeled sections (e.g. "MAPLE CLOUD" / "LOCAL"), each holding a node tree
// that flattens to depth-indented rows for render — a collapsed branch
// simply drops its children from the flattened list rather than nesting a
// separate Collapsible per branch.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiContextMenuComponent } from '../context-menu/mui-context-menu.component';
import type { MuiContextMenuEntry } from '../context-menu/mui-context-menu.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import type { MapleIconName } from '../icon/mui-icon.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiToolbarComponent } from '../toolbar/mui-toolbar.component';
import type { MuiToolbarEntry } from '../toolbar/mui-toolbar.component';
import { MuiTreeRowComponent } from '../tree-row/mui-tree-row.component';
import { toggleId } from '../internal/id-list';

export interface MuiSidebarNode {
  readonly id: string;
  readonly label: string;
  readonly icon?: MapleIconName;
  readonly count?: number | null;
  readonly children?: readonly MuiSidebarNode[];
}

export interface MuiSidebarSection {
  readonly id: string;
  readonly label: string;
  readonly nodes: readonly MuiSidebarNode[];
}

interface FlatSidebarRow {
  readonly node: MuiSidebarNode;
  readonly depth: number;
}

interface FlatSidebarSection {
  readonly section: MuiSidebarSection;
  readonly rows: readonly FlatSidebarRow[];
}

@Component({
  selector: 'mui-sidebar',
  standalone: true,
  imports: [
    MuiContextMenuComponent,
    MuiEmptyStateComponent,
    MuiSpinnerComponent,
    MuiTextComponent,
    MuiToolbarComponent,
    MuiTreeRowComponent,
  ],
  templateUrl: './mui-sidebar.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSidebarComponent {
  readonly sections = input.required<readonly MuiSidebarSection[]>();
  readonly toolbarEntries = input<readonly MuiToolbarEntry[]>([]);
  readonly contextMenuEntries = input<readonly MuiContextMenuEntry[]>([]);
  readonly loading = input<boolean>(false);

  readonly activeId = model<string | null>(null);
  readonly expandedIds = model<readonly string[]>([]);

  readonly toolbarAction = output<string>();
  readonly contextAction = output<{ nodeId: string; actionId: string }>();

  readonly contextMenuNodeId = signal<string | null>(null);
  readonly contextMenuOpen = signal(false);
  readonly contextMenuX = signal(0);
  readonly contextMenuY = signal(0);

  readonly isEmpty = computed(() => this.sections().every((section) => section.nodes.length === 0));

  readonly flatSections = computed<readonly FlatSidebarSection[]>(() =>
    this.sections().map((section) => ({ section, rows: this.flatten(section.nodes, 0) })),
  );

  private flatten(nodes: readonly MuiSidebarNode[], depth: number): readonly FlatSidebarRow[] {
    const expanded = this.expandedIds();
    const rows: FlatSidebarRow[] = [];
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.children?.length && expanded.includes(node.id)) {
        rows.push(...this.flatten(node.children, depth + 1));
      }
    }
    return rows;
  }

  onExpandedChange(id: string, expanded: boolean): void {
    this.expandedIds.update((ids) => toggleId(ids, id, expanded));
  }

  onContextMenu(nodeId: string, event: MouseEvent): void {
    event.preventDefault();
    this.contextMenuNodeId.set(nodeId);
    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuOpen.set(true);
  }

  onContextSelect(actionId: string): void {
    const nodeId = this.contextMenuNodeId();
    if (nodeId) this.contextAction.emit({ nodeId, actionId });
    this.contextMenuOpen.set(false);
  }
}
