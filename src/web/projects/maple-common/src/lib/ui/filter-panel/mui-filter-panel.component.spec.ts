import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiFilterPanelComponent } from './mui-filter-panel.component';
import type { MuiFilterGroup } from './mui-filter-panel.component';

const GROUPS: readonly MuiFilterGroup[] = [
  {
    id: 'camera',
    label: 'Camera',
    searchable: true,
    options: [
      { id: 'a7r5', label: 'Sony A7R V', checked: false },
      { id: 'gfx100', label: 'Fujifilm GFX100', checked: true },
    ],
  },
  {
    id: 'rating',
    label: 'Rating',
    options: [
      { id: '5star', label: '5 stars', checked: false },
      { id: '4star', label: '4 stars', checked: false },
    ],
  },
];

describe('MuiFilterPanelComponent', () => {
  it('opens only the first group by default', () => {
    const fixture = TestBed.createComponent(MuiFilterPanelComponent);
    fixture.componentRef.setInput('groups', GROUPS);
    fixture.detectChanges();

    expect(fixture.componentInstance.openGroupIds()).toEqual(['camera']);
  });

  it('toggles group open state via the collapsible header', () => {
    const fixture = TestBed.createComponent(MuiFilterPanelComponent);
    fixture.componentRef.setInput('groups', GROUPS);
    fixture.detectChanges();

    const headers = fixture.nativeElement.querySelectorAll(
      'mui-collapsible .header',
    ) as NodeListOf<HTMLButtonElement>;
    headers[1].click(); // open "Rating"
    fixture.detectChanges();
    expect(fixture.componentInstance.openGroupIds()).toEqual(['camera', 'rating']);

    headers[0].click(); // close "Camera"
    fixture.detectChanges();
    expect(fixture.componentInstance.openGroupIds()).toEqual(['rating']);
  });

  it('emits optionToggled with the owning group and option ids', () => {
    const fixture = TestBed.createComponent(MuiFilterPanelComponent);
    fixture.componentRef.setInput('groups', GROUPS);
    let captured: { groupId: string; optionId: string; checked: boolean } | null = null;
    fixture.componentInstance.optionToggled.subscribe((event) => (captured = event));
    fixture.detectChanges();

    const checkboxInput = fixture.nativeElement.querySelector(
      'mui-checkbox input',
    ) as HTMLInputElement;
    checkboxInput.checked = true;
    checkboxInput.dispatchEvent(new Event('change'));

    expect(captured).toEqual({ groupId: 'camera', optionId: 'a7r5', checked: true });
  });

  it('narrows a searchable group to options whose label matches the draft text', () => {
    const fixture = TestBed.createComponent(MuiFilterPanelComponent);
    fixture.componentRef.setInput('groups', GROUPS);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('mui-checkbox').length).toBe(4);

    fixture.componentInstance.setGroupSearch('camera', 'fuji');
    fixture.detectChanges();

    // "Fujifilm GFX100" survives the camera-group filter; both Rating
    // options are untouched since that group isn't searchable.
    expect(fixture.nativeElement.querySelectorAll('mui-checkbox').length).toBe(3);
  });

  it('shows the empty state when there are no groups', () => {
    const fixture = TestBed.createComponent(MuiFilterPanelComponent);
    fixture.componentRef.setInput('groups', []);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-empty-state')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('mui-collapsible')).toBeNull();
  });
});
