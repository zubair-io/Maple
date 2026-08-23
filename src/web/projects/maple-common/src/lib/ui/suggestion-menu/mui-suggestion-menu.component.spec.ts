import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import {
  MuiSuggestionMenuComponent,
  type MuiSuggestionItem,
} from './mui-suggestion-menu.component';

const ITEMS: readonly MuiSuggestionItem[] = [
  { id: 'sarah', label: '@sarah', icon: 'person-circle' },
  { id: 'sam', label: '@sam', icon: 'person-circle' },
];

@Component({
  standalone: true,
  imports: [MuiSuggestionMenuComponent],
  template: `
    <div style="position: relative">
      <mui-suggestion-menu [open]="open()" [items]="items" (select)="onSelect($event)" />
    </div>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly items = ITEMS;
  selected: string[] = [];
  onSelect(id: string): void {
    this.selected.push(id);
  }
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiSuggestionMenuComponent', () => {
  it('renders one row per suggestion, with the first row active by default', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items.length).toBe(2);
    expect(items[0].className).toContain('active');
  });

  it('emits select with the item id on click', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    (fixture.nativeElement.querySelectorAll('.item')[1] as HTMLButtonElement).click();
    expect(fixture.componentInstance.selected).toEqual(['sam']);
  });

  it('moves the active row with ArrowDown/ArrowUp, wrapping at the ends', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const list = fixture.nativeElement.querySelector('.mui-suggestion-menu') as HTMLElement;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items[1].className).toContain('active'); // wrapped from index 0 to the last row
  });

  it('selects the active row on Enter', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const list = fixture.nativeElement.querySelector('.mui-suggestion-menu') as HTMLElement;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(fixture.componentInstance.selected).toEqual(['sam']);
  });
});
