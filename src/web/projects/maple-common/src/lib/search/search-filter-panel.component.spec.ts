// SearchFilterPanelComponent — the note shown when a broad text search's
// filters count only its most relevant results (#4431).

import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SearchFilterPanelComponent } from './search-filter-panel.component';
import { EMPTY_FILTERS } from './search-filters';
import type { FacetScope } from '../api/search.service';

function render(scope: FacetScope | null): HTMLElement {
  const fixture = TestBed.createComponent(SearchFilterPanelComponent);
  fixture.componentRef.setInput('filters', EMPTY_FILTERS);
  fixture.componentRef.setInput('scope', scope);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SearchFilterPanelComponent — facet scope note', () => {
  it('says the filters come from the most relevant results when the scope is cut', () => {
    const note = render({ kind: 'top', limit: 2000, of: 98635 }).querySelector(
      '[data-testid="filter-scope-note"]',
    );
    expect(note?.textContent?.trim()).toBe(
      `Filters from the ${(2000).toLocaleString()} most relevant of ${(98635).toLocaleString()} results`,
    );
  });

  it('shows nothing when the filters cover every match', () => {
    expect(render({ kind: 'all' }).querySelector('[data-testid="filter-scope-note"]')).toBeNull();
  });

  it('shows nothing for a server that predates the field', () => {
    expect(render(null).querySelector('[data-testid="filter-scope-note"]')).toBeNull();
  });
});
