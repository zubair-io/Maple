import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiTimelineComponent } from './mui-timeline.component';
import type { MuiTimelineGroup } from './mui-timeline.component';

const GROUPS: readonly MuiTimelineGroup[] = [
  {
    id: 'march',
    label: 'MARCH 2026',
    items: [
      { id: 'a', src: 'a.png', alt: 'A' },
      { id: 'b', src: 'b.png', alt: 'B' },
    ],
  },
  {
    id: 'april',
    label: 'APRIL 2026',
    items: [{ id: 'c', src: 'c.png', alt: 'C' }],
  },
];

function render(): ComponentFixture<MuiTimelineComponent> {
  TestBed.configureTestingModule({ imports: [MuiTimelineComponent] });
  const fixture = TestBed.createComponent(MuiTimelineComponent);
  fixture.componentRef.setInput('groups', GROUPS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiTimelineComponent', () => {
  it('shows a centered spinner while loading', () => {
    const fixture = render();
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-spinner')).toBeTruthy();
  });

  it('shows an empty state when there are no groups, or every group is empty', () => {
    const fixture = render();
    fixture.componentRef.setInput('groups', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain('No photos yet');

    fixture.componentRef.setInput('groups', [{ id: 'x', label: 'X', items: [] }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain('No photos yet');
  });

  it('renders a filter chip row only when filters are supplied', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-chip-row')).toBeNull();

    fixture.componentRef.setInput('filters', [{ id: 'f1', label: 'Favorites' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-chip-row')).toBeTruthy();
  });

  it('renders one sticky group header and one nested grid per group', () => {
    const fixture = render();
    const headers = fixture.nativeElement.querySelectorAll('.group-header');
    const grids = fixture.nativeElement.querySelectorAll('mui-collection-grid');
    expect(headers.length).toBe(2);
    expect(headers[0].textContent).toContain('MARCH 2026');
    expect(headers[1].textContent).toContain('APRIL 2026');
    expect(grids.length).toBe(2);
  });

  it('forwards selection changes from a nested grid into the shared selectedIds', () => {
    const fixture = render();
    const grid = fixture.nativeElement.querySelector(
      'mui-collection-grid .cell-wrap',
    ) as HTMLElement;
    grid.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedIds()).toEqual(['a']);
  });
});
