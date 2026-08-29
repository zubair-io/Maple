// MuiKanbanCardTile — private companion to MuiKanbanBoardComponent. Renders
// one card's content: a `mui-card` when the card has a thumbnail (`src`),
// or a plain title/subtitle block when it doesn't (e.g. a checklist-style
// kanban card with no image). Split out of the board's own template so the
// board's drag-and-drop/column layout doesn't nest a second variant switch
// (image vs. plain, plus the plain variant's own subtitle check) inside its
// per-column/per-card loops — not part of the public API surface (see
// ../public-api.ts), the board is the only consumer.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MuiCardComponent } from '../card/mui-card.component';
import { MuiTextComponent } from '../text/mui-text.component';
import type { MuiKanbanCard } from './mui-kanban-board.component';

@Component({
  selector: 'mui-kanban-card-tile',
  standalone: true,
  imports: [MuiCardComponent, MuiTextComponent],
  templateUrl: './mui-kanban-card-tile.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiKanbanCardTileComponent {
  readonly card = input.required<MuiKanbanCard>();
}
