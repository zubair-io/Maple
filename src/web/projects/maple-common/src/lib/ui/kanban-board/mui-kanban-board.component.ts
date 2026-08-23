// MuiKanbanBoard — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Drag-and-drop column board, built
// from Card, Text.
//
// Drag-and-drop needs immediate visual feedback while the caller still owns
// the real data, so this component keeps an internal `workingColumns` copy
// synced from the `columns` input (an `effect()` re-syncs it on every
// caller update) and renders that copy. A drop mutates the working copy
// functionally — no hit-testing between cards, a drop always appends to the
// end of the target column, per the organism spec — and emits `moved` so
// the caller can commit the same change to its own source of truth.
//
// Deviation from the catalog's building-block list: the row cites Button
// alongside Card and Text, but nothing in this organism's behavior calls
// for one (no retry/add-card affordance was specified), so Button isn't
// imported — an unused import would just be dead weight.

import { ChangeDetectionStrategy, Component, effect, input, output, signal } from '@angular/core';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiSpinnerComponent } from '../spinner/mui-spinner.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiKanbanCardTileComponent } from './mui-kanban-card-tile.component';

export interface MuiKanbanCard {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string | null;
  readonly src?: string | null;
  readonly badgeLabel?: string | null;
}

export interface MuiKanbanColumn {
  readonly id: string;
  readonly title: string;
  readonly cards: readonly MuiKanbanCard[];
}

export interface MuiKanbanMoveEvent {
  readonly cardId: string;
  readonly fromColumnId: string;
  readonly toColumnId: string;
  readonly toIndex: number;
}

@Component({
  selector: 'mui-kanban-board',
  standalone: true,
  imports: [
    MuiEmptyStateComponent,
    MuiKanbanCardTileComponent,
    MuiSpinnerComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-kanban-board.component.html',
  styleUrl: './mui-kanban-board.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiKanbanBoardComponent {
  readonly columns = input.required<readonly MuiKanbanColumn[]>();
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly emptyMessage = input<string>('No cards yet.');

  readonly moved = output<MuiKanbanMoveEvent>();

  protected readonly workingColumns = signal<readonly MuiKanbanColumn[]>([]);

  private readonly draggingCardId = signal<string | null>(null);
  private readonly draggingFromColumnId = signal<string | null>(null);

  constructor() {
    effect(() => this.workingColumns.set(this.columns()));
  }

  onDragStart(cardId: string, columnId: string): void {
    this.draggingCardId.set(cardId);
    this.draggingFromColumnId.set(columnId);
  }

  onDrop(toColumnId: string, event: DragEvent): void {
    event.preventDefault();
    const cardId = this.draggingCardId();
    const fromColumnId = this.draggingFromColumnId();
    this.draggingCardId.set(null);
    this.draggingFromColumnId.set(null);
    if (cardId === null || fromColumnId === null) return;

    const columns = this.workingColumns();
    const sourceColumn = columns.find((column) => column.id === fromColumnId);
    const card = sourceColumn?.cards.find((existing) => existing.id === cardId);
    const targetColumn = columns.find((column) => column.id === toColumnId);
    if (!sourceColumn || !card || !targetColumn) return;

    const toIndex = targetColumn.cards.length;
    const next = columns.map((column) => {
      const withoutCard =
        column.id === fromColumnId
          ? { ...column, cards: column.cards.filter((existing) => existing.id !== cardId) }
          : column;
      return withoutCard.id === toColumnId
        ? { ...withoutCard, cards: [...withoutCard.cards, card] }
        : withoutCard;
    });

    this.workingColumns.set(next);
    this.moved.emit({ cardId, fromColumnId, toColumnId, toIndex });
  }
}
