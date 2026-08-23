import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiBacklinksPanelComponent } from './mui-backlinks-panel.component';
import type { MuiBacklinkItem } from './mui-backlinks-panel.component';

const LINKS: readonly MuiBacklinkItem[] = [
  { id: 'trip-2019', label: 'Iceland 2019', subtitle: 'Album' },
  { id: 'sunset-tag', label: 'Golden Hour', icon: 'tag', subtitle: null },
];

describe('MuiBacklinksPanelComponent', () => {
  it('shows a spinner while loading, hiding rows and the empty state', () => {
    const fixture = TestBed.createComponent(MuiBacklinksPanelComponent);
    fixture.componentRef.setInput('links', LINKS);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-spinner')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('mui-list-row').length).toBe(0);
    expect(fixture.nativeElement.querySelector('mui-empty-state')).toBeNull();
  });

  it('shows the empty state with the given message when there are no links', () => {
    const fixture = TestBed.createComponent(MuiBacklinksPanelComponent);
    fixture.componentRef.setInput('links', []);
    fixture.componentRef.setInput('emptyMessage', 'Nothing links here.');
    fixture.detectChanges();

    const empty = fixture.nativeElement.querySelector('mui-empty-state');
    expect(empty).toBeTruthy();
    expect(empty.querySelector('.title').textContent).toContain('Nothing links here.');
  });

  it('renders one row per link and emits pressed with its id', () => {
    const fixture = TestBed.createComponent(MuiBacklinksPanelComponent);
    fixture.componentRef.setInput('links', LINKS);
    let pressedId: string | null = null;
    fixture.componentInstance.pressed.subscribe((id: string) => (pressedId = id));
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('mui-list-row .mui-list-row');
    expect(rows.length).toBe(2);

    (rows[1] as HTMLElement).click();
    expect(pressedId).toBe('sunset-tag');
  });
});
