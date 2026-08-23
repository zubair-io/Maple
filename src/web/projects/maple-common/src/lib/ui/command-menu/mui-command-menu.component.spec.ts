import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCommandMenuComponent, type MuiCommandItem } from './mui-command-menu.component';

const COMMANDS: readonly MuiCommandItem[] = [
  { id: 'export', label: 'Export image', icon: 'export', shortcut: '⌘E' },
  { id: 'crop', label: 'Crop', icon: 'tool-crop' },
  { id: 'copy', label: 'Copy settings', icon: 'copy' },
];

@Component({
  standalone: true,
  imports: [MuiCommandMenuComponent],
  template: `
    <div style="position: relative">
      <mui-command-menu [open]="open()" [commands]="commands" (select)="onSelect($event)" />
    </div>
  `,
})
class HostComponent {
  readonly open = signal(false);
  readonly commands = COMMANDS;
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

describe('MuiCommandMenuComponent', () => {
  it('lists every command unfiltered, with the first row active', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items.length).toBe(3);
    expect(items[0].className).toContain('active');
  });

  it('filters commands by substring match against the typed query', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'cop';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const items = fixture.nativeElement.querySelectorAll('.item');
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('Copy settings');
  });

  it('shows an empty state when nothing matches', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.item')).toBeNull();
    expect(fixture.nativeElement.querySelector('.empty')?.textContent).toContain(
      'No matching commands',
    );
  });

  it('selects the active filtered command on Enter', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'c';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const menu = fixture.nativeElement.querySelector('.mui-command-menu') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // "c" matches Crop and Copy settings, in that order — ArrowDown once
    // moves the active row to "Copy settings".
    expect(fixture.componentInstance.selected).toEqual(['copy']);
  });

  it('resets the query on every re-open', () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'crop';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.item').length).toBe(1);

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.item').length).toBe(3);
  });
});
