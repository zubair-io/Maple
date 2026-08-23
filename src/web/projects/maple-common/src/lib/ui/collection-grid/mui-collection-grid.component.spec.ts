import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCollectionGridComponent } from './mui-collection-grid.component';
import type { MuiCollectionItem } from './mui-collection-grid.component';

const ITEMS: readonly MuiCollectionItem[] = [
  { id: 'a', src: 'a.png', alt: 'A' },
  { id: 'b', src: 'b.png', alt: 'B' },
  { id: 'c', src: 'c.png', alt: 'C' },
  { id: 'd', src: 'd.png', alt: 'D' },
];

function render(): ComponentFixture<MuiCollectionGridComponent> {
  TestBed.configureTestingModule({ imports: [MuiCollectionGridComponent] });
  const fixture = TestBed.createComponent(MuiCollectionGridComponent);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.componentRef.setInput('columns', 4);
  fixture.componentRef.setInput('cellHeight', 140);
  fixture.componentRef.setInput('viewportHeight', 480);
  fixture.detectChanges();
  return fixture;
}

function cellWraps(fixture: ComponentFixture<MuiCollectionGridComponent>): HTMLElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('.cell-wrap'));
}

function clickCell(
  fixture: ComponentFixture<MuiCollectionGridComponent>,
  index: number,
  init: Partial<MouseEventInit> = {},
): void {
  const el = cellWraps(fixture)[index];
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
  fixture.detectChanges();
}

function dragEventWithDataTransfer(
  type: string,
  init: { clientX?: number; clientY?: number } = {},
): DragEvent {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: { setDragImage: () => {}, effectAllowed: '' },
  });
  Object.defineProperty(event, 'clientX', { configurable: true, value: init.clientX ?? 0 });
  Object.defineProperty(event, 'clientY', { configurable: true, value: init.clientY ?? 0 });
  return event as unknown as DragEvent;
}

describe('MuiCollectionGridComponent', () => {
  it('shows a centered spinner while loading', () => {
    const fixture = render();
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.cell-wrap')).toBeNull();
  });

  it('shows an empty state with the error message when error is set', () => {
    const fixture = render();
    fixture.componentRef.setInput('error', 'Could not load photos.');
    fixture.detectChanges();
    const empty = fixture.nativeElement.querySelector('mui-empty-state');
    expect(empty).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.message').textContent).toContain(
      'Could not load photos.',
    );
  });

  it('shows an empty state with the caller message when there are no items', () => {
    const fixture = render();
    fixture.componentRef.setInput('items', []);
    fixture.componentRef.setInput('emptyMessage', 'Nothing here yet.');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain(
      'Nothing here yet.',
    );
  });

  it('renders one cell per item when populated', () => {
    const fixture = render();
    expect(cellWraps(fixture).length).toBe(ITEMS.length);
  });

  it('a plain click replaces the selection with a single id', () => {
    const fixture = render();
    clickCell(fixture, 0);
    expect(fixture.componentInstance.selectedIds()).toEqual(['a']);
    clickCell(fixture, 2);
    expect(fixture.componentInstance.selectedIds()).toEqual(['c']);
  });

  it('shift-click selects the contiguous range from the anchor', () => {
    const fixture = render();
    clickCell(fixture, 0);
    clickCell(fixture, 2, { shiftKey: true });
    expect(fixture.componentInstance.selectedIds()).toEqual(['a', 'b', 'c']);
  });

  it('cmd/ctrl-click toggles a single id in the selection', () => {
    const fixture = render();
    clickCell(fixture, 0);
    clickCell(fixture, 1, { metaKey: true });
    expect(fixture.componentInstance.selectedIds().slice().sort()).toEqual(['a', 'b']);
    clickCell(fixture, 0, { metaKey: true });
    expect(fixture.componentInstance.selectedIds()).toEqual(['b']);
  });

  it('a double-click emits opened with the item id', () => {
    const fixture = render();
    const opened: string[] = [];
    fixture.componentInstance.opened.subscribe((id) => opened.push(id));
    cellWraps(fixture)[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(opened).toEqual(['b']);
  });

  it('dragstart emits dragStarted with the dragged ids', () => {
    const fixture = render();
    const started: (readonly string[])[] = [];
    fixture.componentInstance.dragStarted.subscribe((ids) => started.push(ids));

    clickCell(fixture, 0);
    clickCell(fixture, 1, { metaKey: true });
    expect(fixture.componentInstance.selectedIds().slice().sort()).toEqual(['a', 'b']);

    cellWraps(fixture)[0].dispatchEvent(dragEventWithDataTransfer('dragstart'));
    expect(started.length).toBe(1);
    expect(started[0].slice().sort()).toEqual(['a', 'b']);
  });

  it('dragging an unselected cell promotes it to a single-item selection first', () => {
    const fixture = render();
    const started: (readonly string[])[] = [];
    fixture.componentInstance.dragStarted.subscribe((ids) => started.push(ids));

    clickCell(fixture, 0);
    cellWraps(fixture)[2].dispatchEvent(dragEventWithDataTransfer('dragstart'));
    expect(started).toEqual([['c']]);
    expect(fixture.componentInstance.selectedIds()).toEqual(['c']);
  });
});
