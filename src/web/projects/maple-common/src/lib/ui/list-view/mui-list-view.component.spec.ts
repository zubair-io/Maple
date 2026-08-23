import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiListViewComponent } from './mui-list-view.component';
import type { MuiListViewItem } from './mui-list-view.component';

const ITEMS: readonly MuiListViewItem[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo', subtitle: 'second' },
  { id: 'c', label: 'Charlie' },
];

function render(): ComponentFixture<MuiListViewComponent> {
  TestBed.configureTestingModule({ imports: [MuiListViewComponent] });
  const fixture = TestBed.createComponent(MuiListViewComponent);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiListViewComponent', () => {
  it('shows a centered spinner while loading', () => {
    const fixture = render();
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-list-row')).toBeNull();
  });

  it('shows an empty state with the error message when error is set', () => {
    const fixture = render();
    fixture.componentRef.setInput('error', 'Could not load list.');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.message').textContent).toContain(
      'Could not load list.',
    );
  });

  it('shows an empty state with the caller message when there are no items', () => {
    const fixture = render();
    fixture.componentRef.setInput('items', []);
    fixture.componentRef.setInput('emptyMessage', 'No results.');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain('No results.');
  });

  it('renders one row per item when populated', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('mui-list-row').length).toBe(ITEMS.length);
  });

  it('clicking a row activates it and emits itemPressed', () => {
    const fixture = render();
    const pressed: string[] = [];
    fixture.componentInstance.itemPressed.subscribe((id) => pressed.push(id));

    const rows = fixture.nativeElement.querySelectorAll('mui-list-row .mui-list-row');
    (rows[1] as HTMLElement).click();
    fixture.detectChanges();

    expect(pressed).toEqual(['b']);
    expect(fixture.componentInstance.activeId()).toBe('b');
    expect(rows[1].classList.contains('is-active')).toBe(true);
  });
});
