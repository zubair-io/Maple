import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiBubbleMenuComponent, type MuiBubbleMenuEntry } from './mui-bubble-menu.component';

const ENTRIES: readonly MuiBubbleMenuEntry[] = [
  { id: 'bold', icon: 'edit', label: 'Bold', active: true },
  { id: 'tag', icon: 'tag', label: 'Highlight' },
  { divider: true },
  { id: 'link', icon: 'share-up-square', label: 'Link' },
];

@Component({
  standalone: true,
  imports: [MuiBubbleMenuComponent],
  template: `
    <div style="position: relative">
      <mui-bubble-menu [open]="open()" [entries]="entries" (itemSelected)="onSelect($event)" />
    </div>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly entries = ENTRIES;
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

describe('MuiBubbleMenuComponent', () => {
  it('renders one icon button per item, a divider for divider entries, and marks the active item', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items.length).toBe(3);
    expect(items[0].className).toContain('active');
    expect(fixture.nativeElement.querySelectorAll('mui-divider').length).toBe(1);
  });

  it('emits itemSelected with the item id on click', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    (fixture.nativeElement.querySelectorAll('.item')[2] as HTMLButtonElement).click();
    expect(fixture.componentInstance.selected).toEqual(['link']);
  });

  it('renders nothing while closed', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-bubble-menu')).toBeNull();
  });
});
