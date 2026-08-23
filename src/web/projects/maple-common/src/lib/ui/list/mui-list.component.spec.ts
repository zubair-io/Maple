import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiListComponent } from './mui-list.component';
import type { MuiListItem } from './mui-list.component';

function render(items: readonly MuiListItem[]): ComponentFixture<MuiListComponent> {
  TestBed.configureTestingModule({ imports: [MuiListComponent] });
  const fixture = TestBed.createComponent(MuiListComponent);
  fixture.componentRef.setInput('items', items);
  fixture.detectChanges();
  return fixture;
}

describe('MuiListComponent', () => {
  const flat: MuiListItem[] = [{ text: 'First item' }, { text: 'Second item' }];

  it('renders an unordered list by default, one <li> per item', () => {
    const fixture = render(flat);
    const ul = fixture.nativeElement.querySelector('ul.mui-list');
    expect(ul).toBeTruthy();
    expect(fixture.nativeElement.querySelector('ol.mui-list')).toBeNull();
    const items = ul.querySelectorAll(':scope > li');
    expect(items.length).toBe(2);
    expect(items[0].textContent?.trim()).toContain('First item');
    expect(items[1].textContent?.trim()).toContain('Second item');
  });

  it('renders an <ol> when ordered is set', () => {
    const fixture = render(flat);
    fixture.componentRef.setInput('ordered', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ol.mui-list')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('ul.mui-list')).toBeNull();
  });

  it('reflects marker and density inputs as rendered classes', () => {
    const fixture = render(flat);
    fixture.componentRef.setInput('marker', 'dash');
    fixture.componentRef.setInput('density', 'compact');
    fixture.detectChanges();
    const list = fixture.nativeElement.querySelector('.mui-list') as HTMLElement;
    expect(list.className).toContain('marker-dash');
    expect(list.className).toContain('density-compact');
  });

  it('renders nested children as an indented sub-list inside the parent <li>', () => {
    const nested: MuiListItem[] = [
      { text: 'Parent', children: [{ text: 'Child A' }, { text: 'Child B' }] },
      { text: 'Sibling' },
    ];
    const fixture = render(nested);
    // The outer <ul> is the first ul.mui-list in document order — its direct
    // <li> children are the top level; a plain `ul.mui-list > li` selector
    // would also match the nested sub-list's own items (they satisfy the
    // same "direct child of a .mui-list" shape one level deeper).
    const outerList = fixture.nativeElement.querySelector('ul.mui-list') as HTMLElement;
    const topLevelItems = outerList.querySelectorAll(':scope > li');
    expect(topLevelItems.length).toBe(2);
    const parentLi = topLevelItems[0] as HTMLElement;
    const nestedList = parentLi.querySelector('ul.mui-list');
    expect(nestedList).toBeTruthy();
    const nestedItems = nestedList!.querySelectorAll(':scope > li');
    expect(nestedItems.length).toBe(2);
    expect(nestedItems[0].textContent?.trim()).toContain('Child A');
    expect(nestedItems[1].textContent?.trim()).toContain('Child B');
    // The sibling item carries no nested list of its own.
    expect((topLevelItems[1] as HTMLElement).querySelector('ul.mui-list')).toBeNull();
  });
});
