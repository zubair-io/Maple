import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageSearchComponent } from './mui-page-search.component';

describe('MuiPageSearchComponent', () => {
  it('renders the Search organism filling App Shell Content', () => {
    const fixture = TestBed.createComponent(MuiPageSearchComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-search')).toBeTruthy();
    expect(fixture.componentInstance.results().length).toBe(6);
  });

  it('narrows results to match the query text', () => {
    const fixture = TestBed.createComponent(MuiPageSearchComponent);
    fixture.detectChanges();

    fixture.componentInstance.query.set('wedding');
    fixture.detectChanges();

    const results = fixture.componentInstance.results();
    expect(results.length).toBe(2);
    expect(results.every((r) => r.alt.toLowerCase().includes('wedding'))).toBe(true);
    expect(fixture.componentInstance.totalCount()).toBe(2);
  });

  it('selecting a suggestion sets the query and narrows results', () => {
    const fixture = TestBed.createComponent(MuiPageSearchComponent);
    fixture.detectChanges();

    fixture.componentInstance.onSuggestionSelected('sg1');
    fixture.detectChanges();

    expect(fixture.componentInstance.query()).toBe('ballet recital');
    expect(fixture.componentInstance.results().length).toBe(2);
  });
});
