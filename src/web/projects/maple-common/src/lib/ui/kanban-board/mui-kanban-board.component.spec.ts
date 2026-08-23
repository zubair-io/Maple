import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiKanbanBoardComponent } from './mui-kanban-board.component';
import type { MuiKanbanColumn, MuiKanbanMoveEvent } from './mui-kanban-board.component';

const COLUMNS: readonly MuiKanbanColumn[] = [
  {
    id: 'todo',
    title: 'To Do',
    cards: [
      { id: 'c1', title: 'Cull the shoot' },
      { id: 'c2', title: 'Pick heroes', src: 'hero.png' },
    ],
  },
  { id: 'done', title: 'Done', cards: [{ id: 'c3', title: 'Export' }] },
];

function render(): ComponentFixture<MuiKanbanBoardComponent> {
  TestBed.configureTestingModule({ imports: [MuiKanbanBoardComponent] });
  const fixture = TestBed.createComponent(MuiKanbanBoardComponent);
  fixture.componentRef.setInput('columns', COLUMNS);
  fixture.detectChanges();
  return fixture;
}

function dragEvent(type: string): DragEvent {
  return new Event(type, { bubbles: true }) as unknown as DragEvent;
}

describe('MuiKanbanBoardComponent', () => {
  it('shows a centered spinner while loading', () => {
    const fixture = render();
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).toBeTruthy();
  });

  it('shows an empty state with the error message when error is set', () => {
    const fixture = render();
    fixture.componentRef.setInput('error', 'Could not load board.');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.message').textContent).toContain(
      'Could not load board.',
    );
  });

  it('shows an empty state when there are no columns', () => {
    const fixture = render();
    fixture.componentRef.setInput('columns', []);
    fixture.componentRef.setInput('emptyMessage', 'Start a board.');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain('Start a board.');
  });

  it('renders every column with its cards, plain-div for cards with no src', () => {
    const fixture = render();
    const columns = fixture.nativeElement.querySelectorAll('.column');
    expect(columns.length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.card-wrap').length).toBe(3);
    expect(fixture.nativeElement.querySelectorAll('.card-plain').length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('mui-card').length).toBe(1);
  });

  it('dropping a card mutates the working columns and emits moved', () => {
    const fixture = render();
    const moves: MuiKanbanMoveEvent[] = [];
    fixture.componentInstance.moved.subscribe((event) => moves.push(event));

    const cardWraps = fixture.nativeElement.querySelectorAll('.card-wrap');
    cardWraps[0].dispatchEvent(dragEvent('dragstart'));

    const columns = fixture.nativeElement.querySelectorAll('.column');
    columns[1].dispatchEvent(dragEvent('drop'));
    fixture.detectChanges();

    expect(moves).toEqual([{ cardId: 'c1', fromColumnId: 'todo', toColumnId: 'done', toIndex: 1 }]);

    const columnsAfter = fixture.nativeElement.querySelectorAll('.column');
    const titlesIn = (column: Element): string[] =>
      Array.from(column.querySelectorAll('.card-wrap mui-text'))
        .map((el) => el.textContent?.trim())
        .filter((text): text is string => !!text);

    expect(titlesIn(columnsAfter[0])).toEqual(['Pick heroes']);
    expect(titlesIn(columnsAfter[1])).toContain('Export');
    expect(titlesIn(columnsAfter[1])).toContain('Cull the shoot');
  });
});
