// MuiPageBoard — Maple UI Pages (unified-component-catalog.md §6). App
// Shell with the Kanban Board filling Content.
//
// Cross-organism wiring: the Kanban Board only emits `moved` — it doesn't
// mutate its own `columns` input. The page applies the move to its own
// column state (so a drag actually relocates the card, not just fires an
// event) and reflects the result in a status line in Nav.

import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MuiAppShellComponent } from '../../app-shell/mui-app-shell.component';
import { MuiTextComponent } from '../../text/mui-text.component';
import { MuiKanbanBoardComponent } from '../../kanban-board/mui-kanban-board.component';
import type {
  MuiKanbanColumn,
  MuiKanbanMoveEvent,
} from '../../kanban-board/mui-kanban-board.component';
import { pageThumb } from '../internal/mock-media';

const INITIAL_COLUMNS: readonly MuiKanbanColumn[] = [
  {
    id: 'todo',
    title: 'To do',
    cards: [
      { id: 'k1', title: 'Cull import batch' },
      { id: 'k2', title: 'Tag faces' },
    ],
  },
  {
    id: 'doing',
    title: 'Doing',
    cards: [{ id: 'k3', title: 'Ballet recital', src: pageThumb(0) }],
  },
  {
    id: 'done',
    title: 'Done',
    cards: [{ id: 'k4', title: 'Studio portraits', src: pageThumb(1), badgeLabel: 'Exported' }],
  },
];

@Component({
  selector: 'mui-page-board',
  standalone: true,
  imports: [MuiAppShellComponent, MuiTextComponent, MuiKanbanBoardComponent],
  templateUrl: './mui-page-board.component.html',
  styleUrl: './mui-page-board.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageBoardComponent {
  readonly columns = signal<readonly MuiKanbanColumn[]>(INITIAL_COLUMNS);
  readonly statusText = signal<string>('No cards moved yet.');

  onMoved(move: MuiKanbanMoveEvent): void {
    const source = this.columns().find((c) => c.id === move.fromColumnId);
    const card = source?.cards.find((c) => c.id === move.cardId);
    if (!source || !card) return;

    this.columns.update((columns) =>
      columns.map((column) => {
        if (column.id === move.fromColumnId && column.id === move.toColumnId) return column;
        if (column.id === move.fromColumnId) {
          return { ...column, cards: column.cards.filter((c) => c.id !== move.cardId) };
        }
        if (column.id === move.toColumnId) {
          const cards = column.cards.slice();
          cards.splice(move.toIndex, 0, card);
          return { ...column, cards };
        }
        return column;
      }),
    );

    const toColumn = this.columns().find((c) => c.id === move.toColumnId);
    this.statusText.set(`Moved "${card.title}" → ${toColumn?.title ?? move.toColumnId}`);
  }
}
