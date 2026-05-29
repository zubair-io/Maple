// SearchScopeChipsComponent — single-select + emit tests.

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SearchScopeChipsComponent } from './search-scope-chips.component';
import { SearchScope } from './search-types';

@Component({
  standalone: true,
  imports: [SearchScopeChipsComponent],
  template: ` <app-search-scope-chips [scope]="scope()" (scopeChange)="onChange($event)" /> `,
})
class HostComponent {
  scope = signal<SearchScope>('all');
  changes: SearchScope[] = [];
  onChange(s: SearchScope) {
    this.changes.push(s);
    this.scope.set(s);
  }
}

describe('SearchScopeChipsComponent', () => {
  it('renders one chip per scope', () => {
    const f = TestBed.createComponent(HostComponent);
    f.detectChanges();
    const chips = f.nativeElement.querySelectorAll('button.chip');
    expect(chips.length).toBe(5);
  });

  it('marks the selected scope with aria-selected', () => {
    const f = TestBed.createComponent(HostComponent);
    f.detectChanges();
    const all = f.nativeElement.querySelector('[data-testid="search-scope-all"]');
    const photos = f.nativeElement.querySelector('[data-testid="search-scope-photos"]');
    expect(all.getAttribute('aria-selected')).toBe('true');
    expect(photos.getAttribute('aria-selected')).toBe('false');
  });

  it('emits scopeChange on a different chip tap', () => {
    const f = TestBed.createComponent(HostComponent);
    f.detectChanges();
    const photos = f.nativeElement.querySelector(
      '[data-testid="search-scope-photos"]',
    ) as HTMLElement;
    photos.click();
    f.detectChanges();
    expect(f.componentInstance.changes).toEqual(['photos']);
    const photosNow = f.nativeElement.querySelector('[data-testid="search-scope-photos"]');
    expect(photosNow.getAttribute('aria-selected')).toBe('true');
  });

  it('does not re-emit when tapping the already-selected chip', () => {
    const f = TestBed.createComponent(HostComponent);
    f.detectChanges();
    const all = f.nativeElement.querySelector('[data-testid="search-scope-all"]') as HTMLElement;
    all.click();
    all.click();
    f.detectChanges();
    expect(f.componentInstance.changes).toEqual([]);
  });
});
