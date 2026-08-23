import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiToolDockComponent } from './mui-tool-dock.component';
import type { MuiToolDockEntry } from './mui-tool-dock.component';

const ENTRIES: readonly MuiToolDockEntry[] = [
  { id: 'crop', icon: 'scope', label: 'Crop' },
  { id: 'heal', icon: 'droplet', label: 'Heal' },
  { divider: true },
  { id: 'locked', icon: 'gear', label: 'Locked', disabled: true },
];

describe('MuiToolDockComponent', () => {
  it('selects a tool on press, updating activeId and emitting toolSelected', () => {
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    let selected: string | null = null;
    fixture.componentInstance.toolSelected.subscribe((id: string) => (selected = id));
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('mui-action-button button') as HTMLButtonElement).click();

    expect(selected).toBe('crop');
    expect(fixture.componentInstance.activeId()).toBe('crop');
  });

  it('does not select or emit for a disabled tool', () => {
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    let selected: string | null = null;
    fixture.componentInstance.toolSelected.subscribe((id: string) => (selected = id));
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll(
      'mui-action-button button',
    ) as NodeListOf<HTMLButtonElement>;
    buttons[2].click(); // "Locked", the disabled entry

    expect(selected).toBeNull();
    expect(fixture.componentInstance.activeId()).toBeNull();
  });

  it('renders a divider for each divider entry', () => {
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('mui-action-button').length).toBe(3);
    expect(fixture.nativeElement.querySelectorAll('mui-divider').length).toBe(1);
  });

  it('toggles the horizontal layout class from the orientation input', () => {
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.mui-tool-dock.is-horizontal')).toBeNull();

    fixture.componentRef.setInput('orientation', 'horizontal');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.mui-tool-dock.is-horizontal')).toBeTruthy();
  });
});
