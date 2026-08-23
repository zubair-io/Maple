import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiContextMenuComponent, type MuiContextMenuEntry } from './mui-context-menu.component';

const ENTRIES: readonly MuiContextMenuEntry[] = [
  { id: 'rename', label: 'Rename', icon: 'edit' },
  { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
  { divider: true },
  { id: 'delete', label: 'Delete', icon: 'trash', destructive: true },
  { id: 'locked', label: 'Locked', disabled: true },
];

@Component({
  standalone: true,
  imports: [MuiContextMenuComponent],
  template: `
    <div style="position: relative">
      <mui-context-menu
        [open]="open()"
        [entries]="entries"
        (select)="onSelect($event)"
        (closeRequested)="closeCount = closeCount + 1"
      />
    </div>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly entries = ENTRIES;
  closeCount = 0;
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

describe('MuiContextMenuComponent', () => {
  it('renders one row per item, a divider for divider entries, and skips item fields for it', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items.length).toBe(4);
    expect(fixture.nativeElement.querySelectorAll('mui-divider').length).toBe(1);
    expect(items[2].className).toContain('destructive');
  });

  it('emits select with the item id on click, but not for a disabled item', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item') as NodeListOf<HTMLButtonElement>;
    items[0].click();
    expect(fixture.componentInstance.selected).toEqual(['rename']);

    items[3].click(); // disabled "Locked" row
    expect(fixture.componentInstance.selected).toEqual(['rename']);
  });

  it('navigates active row with ArrowDown/ArrowUp, skipping the divider, and selects on Enter', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const menu = fixture.nativeElement.querySelector('.mui-context-menu') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items[1].className).toContain('active'); // "Duplicate" — divider is skipped

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(fixture.componentInstance.selected).toEqual(['delete']);
  });

  it('resets the active row every time the menu re-opens', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    const menu = fixture.nativeElement.querySelector('.mui-context-menu') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.selected).toEqual([]);

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.item.active')).toBeNull();
  });
});
