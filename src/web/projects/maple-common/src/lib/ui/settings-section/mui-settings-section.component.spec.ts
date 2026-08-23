import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type {
  MuiSettingsSectionFieldChange,
  MuiSettingsSectionRow,
} from './mui-settings-section.component';
import { MuiSettingsSectionComponent } from './mui-settings-section.component';

const ROWS: readonly MuiSettingsSectionRow[] = [
  { kind: 'navigate', id: 'storage', label: 'Storage location', value: '/Volumes/Photos' },
  { kind: 'edit', id: 'sync-interval', label: 'Sync interval', value: '15 minutes' },
];

@Component({
  standalone: true,
  imports: [MuiSettingsSectionComponent],
  template: `
    <mui-settings-section
      title="General"
      [rows]="rows()"
      [banner]="banner()"
      (rowActivated)="activated = $event"
      (fieldChanged)="lastChange = $event"
    />
  `,
})
class HostComponent {
  readonly rows = signal(ROWS);
  readonly banner = signal<{ message: string; variant: 'warning' } | null>(null);
  activated: string | null = null;
  lastChange: MuiSettingsSectionFieldChange | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiSettingsSectionComponent', () => {
  it('renders the section title and one row per entry', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.title')?.textContent?.trim()).toBe('General');
    expect(el.querySelectorAll('mui-list-row').length).toBe(1);
    expect(el.querySelectorAll('mui-settings-row').length).toBe(1);
  });

  it('emits rowActivated with the row id when a navigable row is pressed', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-list-row') as HTMLElement).click();
    expect(host.activated).toBe('storage');
  });

  it("emits fieldChanged when an editable row's inline FormField commits a new value", () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;

    // The settings-row's collapsible body always projects its content (only
    // the height animates), so the FormField is reachable without a click.
    const input = el.querySelector('mui-settings-row mui-form-field input') as HTMLInputElement;
    input.value = '30 minutes';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(host.lastChange).toEqual({ id: 'sync-interval', value: '30 minutes' });
  });

  it('renders a banner when provided', () => {
    const { fixture, host } = render();
    expect(fixture.nativeElement.querySelector('mui-banner')).toBeNull();

    host.banner.set({ message: 'Changes require restart', variant: 'warning' });
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('mui-banner') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Changes require restart');
  });
});
