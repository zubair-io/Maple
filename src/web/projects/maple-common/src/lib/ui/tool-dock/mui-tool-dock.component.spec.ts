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

  it('passes title, ariaHidden and modified through to the action button', () => {
    const entries: readonly MuiToolDockEntry[] = [
      {
        id: 'mask',
        icon: 'gear',
        label: 'Mask',
        disabled: true,
        title: 'Mask — coming in #1541',
        ariaHidden: true,
      },
      { id: 'light', icon: 'scope', label: 'Light', modified: true },
    ];
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', entries);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll(
      'mui-action-button button',
    ) as NodeListOf<HTMLButtonElement>;
    expect(buttons[0].getAttribute('title')).toBe('Mask — coming in #1541');
    expect(buttons[0].getAttribute('aria-hidden')).toBe('true');
    expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    expect(fixture.nativeElement.querySelector('.modified-dot')).not.toBeNull();
  });

  it('an explicit selected per-entry wins over the activeId fallback', () => {
    const entries: readonly MuiToolDockEntry[] = [
      { id: 'crop', icon: 'scope', label: 'Crop', selected: false },
      { id: 'heal', icon: 'droplet', label: 'Heal', selected: true },
    ];
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', entries);
    fixture.componentInstance.activeId.set('crop');
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll(
      'mui-action-button button',
    ) as NodeListOf<HTMLButtonElement>;
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('derives per-item icon/label layout from orientation by default', () => {
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    fixture.detectChanges();
    expect(fixture.componentInstance.itemOrientation()).toBe('stacked');

    fixture.componentRef.setInput('orientation', 'horizontal');
    fixture.detectChanges();
    expect(fixture.componentInstance.itemOrientation()).toBe('horizontal');
  });

  it('itemOrientationOverride pins the per-item layout regardless of the row axis', () => {
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', ENTRIES);
    fixture.componentRef.setInput('orientation', 'horizontal');
    fixture.componentRef.setInput('itemOrientationOverride', 'stacked');
    fixture.detectChanges();

    expect(fixture.componentInstance.itemOrientation()).toBe('stacked');
    expect(
      (fixture.nativeElement.querySelector('mui-action-button button') as HTMLElement).className,
    ).toContain('orientation-stacked');
  });

  it('a panel entry emits toolSelected without moving the activeId single-select model', () => {
    const entries: readonly MuiToolDockEntry[] = [
      { id: 'crop', icon: 'scope', label: 'Crop' },
      { id: 'curve', icon: 'droplet', label: 'Tone Curve', panel: true },
    ];
    const fixture = TestBed.createComponent(MuiToolDockComponent);
    fixture.componentRef.setInput('entries', entries);
    let selected: string | null = null;
    fixture.componentInstance.toolSelected.subscribe((id: string) => (selected = id));
    fixture.componentInstance.activeId.set('crop');
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll(
      'mui-action-button button',
    ) as NodeListOf<HTMLButtonElement>;
    buttons[1].click(); // "Tone Curve", the panel entry

    expect(selected).toBe('curve');
    expect(fixture.componentInstance.activeId()).toBe('crop');
  });
});
