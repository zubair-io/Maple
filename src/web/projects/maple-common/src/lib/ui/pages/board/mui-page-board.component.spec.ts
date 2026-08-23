import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageBoardComponent } from './mui-page-board.component';

describe('MuiPageBoardComponent', () => {
  it('renders the Kanban Board inside App Shell Content', () => {
    const fixture = TestBed.createComponent(MuiPageBoardComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-kanban-board')).toBeTruthy();
    expect(fixture.componentInstance.columns().length).toBe(3);
  });

  it('applies a moved card to the target column and updates the Nav status line', () => {
    const fixture = TestBed.createComponent(MuiPageBoardComponent);
    fixture.detectChanges();

    fixture.componentInstance.onMoved({
      cardId: 'k1',
      fromColumnId: 'todo',
      toColumnId: 'done',
      toIndex: 0,
    });
    fixture.detectChanges();

    const columns = fixture.componentInstance.columns();
    expect(columns.find((c) => c.id === 'todo')?.cards.some((c) => c.id === 'k1')).toBe(false);
    expect(columns.find((c) => c.id === 'done')?.cards[0]?.id).toBe('k1');
    expect(fixture.componentInstance.statusText()).toContain('Cull import batch');
    expect(fixture.componentInstance.statusText()).toContain('Done');
  });
});
