import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { MuiSelectivePasteGroup } from './mui-selective-paste-modal.component';
import { MuiSelectivePasteModalComponent } from './mui-selective-paste-modal.component';

const GROUPS: readonly MuiSelectivePasteGroup[] = [
  { id: 'exposure', label: 'Exposure', enabled: true },
  { id: 'color', label: 'Color', enabled: true },
  { id: 'crop', label: 'Crop', description: 'Crop and straighten', enabled: false },
];

@Component({
  standalone: true,
  imports: [MuiSelectivePasteModalComponent],
  template: `
    <mui-selective-paste-modal
      [open]="open()"
      [(groups)]="groups"
      (pasteConfirmed)="onPasteConfirmed($event)"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly groups = signal<readonly MuiSelectivePasteGroup[]>(GROUPS);
  dismissedCount = 0;
  lastEnabledIds: readonly string[] | null = null;

  onPasteConfirmed(ids: readonly string[]): void {
    this.lastEnabledIds = ids;
  }
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function toggle(input: HTMLInputElement, checked: boolean): void {
  input.checked = checked;
  input.dispatchEvent(new Event('change'));
}

describe('MuiSelectivePasteModalComponent', () => {
  it('renders one checkbox per group, reflecting its enabled state', () => {
    const { fixture } = render();
    const checkboxes = fixture.nativeElement.querySelectorAll(
      'mui-checkbox input',
    ) as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBe(3);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[2].checked).toBe(false);
  });

  it('toggling a checkbox updates the bound groups model', () => {
    const { fixture, host } = render();
    const checkboxes = fixture.nativeElement.querySelectorAll(
      'mui-checkbox input',
    ) as NodeListOf<HTMLInputElement>;
    toggle(checkboxes[2], true);
    fixture.detectChanges();
    expect(host.groups().find((group) => group.id === 'crop')?.enabled).toBe(true);
  });

  it('emits only the ids of groups left enabled on Paste', () => {
    const { fixture, host } = render();
    const checkboxes = fixture.nativeElement.querySelectorAll(
      'mui-checkbox input',
    ) as NodeListOf<HTMLInputElement>;
    toggle(checkboxes[1], false); // disable color
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll(
      '.mui-selective-paste-modal-footer button',
    );
    (buttons[1] as HTMLButtonElement).click();

    expect(host.lastEnabledIds).toEqual(['exposure']);
  });

  it('disables Paste once every group is unchecked', () => {
    const { fixture, host } = render();
    host.groups.set(GROUPS.map((group) => ({ ...group, enabled: false })));
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll(
      '.mui-selective-paste-modal-footer button',
    );
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('emits dismissed on Cancel', () => {
    const { fixture, host } = render();
    const buttons = fixture.nativeElement.querySelectorAll(
      '.mui-selective-paste-modal-footer button',
    );
    (buttons[0] as HTMLButtonElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
