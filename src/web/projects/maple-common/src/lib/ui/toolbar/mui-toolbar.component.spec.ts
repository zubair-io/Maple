import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiToolbarComponent, type MuiToolbarEntry } from './mui-toolbar.component';

const ENTRIES: readonly MuiToolbarEntry[] = [
  { id: 'undo', icon: 'undo-uturn', label: 'Undo' },
  { id: 'redo', icon: 'redo-uturn', label: 'Redo' },
  { divider: true },
  { id: 'export', icon: 'export', label: 'Export' },
  { id: 'settings', icon: 'gear', label: 'Settings' },
];

describe('MuiToolbarComponent', () => {
  it('renders every entry inline with no overflow button when maxVisible is unset', () => {
    const fixture = TestBed.createComponent(MuiToolbarComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('mui-action-button').length).toBe(4);
    expect(fixture.nativeElement.querySelector('.overflow-anchor')).toBeNull();
  });

  it('emits itemSelected with the item id when a visible action fires', () => {
    const fixture = TestBed.createComponent(MuiToolbarComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    let selected: string | null = null;
    fixture.componentInstance.itemSelected.subscribe((id: string) => (selected = id));
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.mui-action-button') as HTMLButtonElement).click();
    expect(selected).toBe('undo');
  });

  it('collapses items beyond maxVisible into an overflow popover', () => {
    const fixture = TestBed.createComponent(MuiToolbarComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    fixture.componentRef.setInput('maxVisible', 2);
    fixture.detectChanges();

    // 2 visible items + 1 overflow-trigger action-button = 3
    expect(fixture.nativeElement.querySelectorAll('mui-action-button').length).toBe(3);
    expect(fixture.nativeElement.querySelector('.overflow-anchor')).toBeTruthy();
    expect(fixture.componentInstance.split().overflow.map((i) => i.id)).toEqual([
      'export',
      'settings',
    ]);
  });

  it('selecting an overflow item emits itemSelected and closes the popover', () => {
    const fixture = TestBed.createComponent(MuiToolbarComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    fixture.componentRef.setInput('maxVisible', 2);
    let selected: string | null = null;
    fixture.componentInstance.itemSelected.subscribe((id: string) => (selected = id));
    fixture.detectChanges();

    fixture.componentInstance.overflowOpen.set(true);
    fixture.detectChanges();

    const overflowItem = fixture.nativeElement.querySelector('.overflow-item') as HTMLButtonElement;
    overflowItem.click();

    expect(selected).toBe('export');
    expect(fixture.componentInstance.overflowOpen()).toBe(false);
  });
});
