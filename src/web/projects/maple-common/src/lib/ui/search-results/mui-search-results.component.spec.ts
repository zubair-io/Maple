import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSearchResultsComponent } from './mui-search-results.component';
import type { MuiCollectionItem } from './mui-search-results.component';

const ITEMS: readonly MuiCollectionItem[] = [
  { id: 'a', src: 'a.png', alt: 'A' },
  { id: 'b', src: 'b.png', alt: 'B' },
];

function render(): ComponentFixture<MuiSearchResultsComponent> {
  TestBed.configureTestingModule({ imports: [MuiSearchResultsComponent] });
  const fixture = TestBed.createComponent(MuiSearchResultsComponent);
  fixture.componentRef.setInput('items', ITEMS);
  fixture.componentRef.setInput('totalCount', 2);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSearchResultsComponent', () => {
  it('shows an indeterminate progress bar while loading', () => {
    const fixture = render();
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    const progress = fixture.nativeElement.querySelector('mui-progress');
    expect(progress).toBeTruthy();
  });

  it('shows an empty state with the query text when there are no results', () => {
    const fixture = render();
    fixture.componentRef.setInput('items', []);
    fixture.componentRef.setInput('query', 'sunset');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.title').textContent).toContain('No results');
    expect(fixture.nativeElement.querySelector('.message').textContent).toContain('sunset');
  });

  it('renders the collection grid when there are results', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-collection-grid')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-empty-state')).toBeNull();
  });

  it('hides the pager when there is only one page', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.pager')).toBeNull();
  });

  it('disables Previous on page 1 and Next on the last page, and emits pageChanged', () => {
    const fixture = render();
    fixture.componentRef.setInput('page', 1);
    fixture.componentRef.setInput('pageCount', 3);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.pager mui-button button');
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);

    const pages: number[] = [];
    fixture.componentInstance.pageChanged.subscribe((page) => pages.push(page));
    (buttons[1] as HTMLButtonElement).click();
    expect(pages).toEqual([2]);

    fixture.componentRef.setInput('page', 3);
    fixture.detectChanges();
    const buttonsAtEnd = fixture.nativeElement.querySelectorAll('.pager mui-button button');
    expect((buttonsAtEnd[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttonsAtEnd[1] as HTMLButtonElement).disabled).toBe(true);
  });
});
