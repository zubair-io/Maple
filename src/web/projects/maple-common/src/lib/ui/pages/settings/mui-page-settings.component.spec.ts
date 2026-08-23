import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPageSettingsComponent } from './mui-page-settings.component';

describe('MuiPageSettingsComponent', () => {
  it('renders Settings Section in the Pane by default, with the section list in Nav', () => {
    const fixture = TestBed.createComponent(MuiPageSettingsComponent);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[slot=nav] mui-list-row').length).toBe(3);
    expect(el.querySelector('mui-settings-section')).toBeTruthy();
    expect(el.querySelector('mui-device-list')).toBeNull();
  });

  it('swaps the Pane to Device List / User Management when the Nav selection changes', () => {
    const fixture = TestBed.createComponent(MuiPageSettingsComponent);
    fixture.detectChanges();

    fixture.componentInstance.activeSectionId.set('devices');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-device-list')).toBeTruthy();

    fixture.componentInstance.activeSectionId.set('users');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('mui-user-management')).toBeTruthy();
  });

  it('applies a Settings Section field edit back into its own row data', () => {
    const fixture = TestBed.createComponent(MuiPageSettingsComponent);
    fixture.detectChanges();

    fixture.componentInstance.onSettingsFieldChanged({ id: 'sync-interval', value: '5 minutes' });
    fixture.detectChanges();

    const row = fixture.componentInstance.settingsRows().find((r) => r.id === 'sync-interval');
    expect(row?.value).toBe('5 minutes');
  });
});
