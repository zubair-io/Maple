import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiChip } from '../chip-row/mui-chip-row.component';
import type { MuiCollectionItem } from '../search-results/mui-search-results.component';
import type { MuiSuggestionItem } from '../suggestion-menu/mui-suggestion-menu.component';
import { MuiSearchComponent } from './mui-search.component';

const RESULTS: readonly MuiCollectionItem[] = [
  { id: 'p1', src: '/p1.jpg', alt: 'Photo 1' },
  { id: 'p2', src: '/p2.jpg', alt: 'Photo 2' },
];

const SUGGESTIONS: readonly MuiSuggestionItem[] = [
  { id: 'sunset', label: 'sunset' },
  { id: 'sunrise', label: 'sunrise' },
];

const CHIPS: readonly MuiChip[] = [{ id: 'chip-1', label: 'RAW' }];

function render(): ComponentFixture<MuiSearchComponent> {
  const fixture = TestBed.createComponent(MuiSearchComponent);
  fixture.componentRef.setInput('results', RESULTS);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSearchComponent', () => {
  it('two-way binds query through the search bar', () => {
    const fixture = render();
    const input = fixture.nativeElement.querySelector('mui-search-bar input') as HTMLInputElement;
    input.value = 'iceland';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.query()).toBe('iceland');
  });

  it('emits suggestionSelected when a suggestion is chosen', () => {
    const fixture = render();
    fixture.componentRef.setInput('suggestions', SUGGESTIONS);
    fixture.componentRef.setInput('suggestionsOpen', true);
    let selected: string | null = null;
    fixture.componentInstance.suggestionSelected.subscribe((id: string) => (selected = id));
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('mui-suggestion-menu .item') as HTMLButtonElement).click();

    expect(selected).toBe('sunset');
  });

  it('toggles the filter panel from the search bar action button', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('mui-filter-panel')).toBeNull();

    const filtersButton = fixture.nativeElement.querySelector(
      'mui-search-bar mui-button button',
    ) as HTMLButtonElement;
    filtersButton.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-filter-panel')).toBeTruthy();

    filtersButton.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-filter-panel')).toBeNull();
  });

  it('emits chipRemoved with the removed chip id', () => {
    const fixture = render();
    fixture.componentRef.setInput('activeChips', CHIPS);
    let removedId: string | null = null;
    fixture.componentInstance.chipRemoved.subscribe((id: string) => (removedId = id));
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('mui-chip-row .remove') as HTMLButtonElement).click();

    expect(removedId).toBe('chip-1');
  });
});
