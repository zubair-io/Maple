import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiShareModalComponent } from './mui-share-modal.component';
import type { MuiShareMember } from './mui-share-modal.component';

const MEMBERS: MuiShareMember[] = [
  { id: 'm1', name: 'Ada Lovelace', role: 'Editor' },
  { id: 'm2', name: 'Grace Hopper', role: 'Viewer' },
];

@Component({
  standalone: true,
  imports: [MuiShareModalComponent],
  template: `
    <mui-share-modal
      [open]="open()"
      [members]="members()"
      [(inviteValue)]="inviteValue"
      (memberInvited)="invited = $event"
      (memberRemoved)="removed = $event"
      (dismissed)="dismissedCount = dismissedCount + 1"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly members = signal<readonly MuiShareMember[]>(MEMBERS);
  readonly inviteValue = signal('');
  invited: string | null = null;
  removed: string | null = null;
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiShareModalComponent', () => {
  it('renders one list row per member', () => {
    const { fixture } = render();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('mui-list-row');
    expect(rows.length).toBe(2);
  });

  it('emits memberInvited with the typed email and clears the field', () => {
    const { fixture, host } = render();
    host.inviteValue.set('new@example.com');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const inviteBtn = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Invite',
    ) as HTMLButtonElement;
    inviteBtn.click();
    expect(host.invited).toBe('new@example.com');
    expect(host.inviteValue()).toBe('');
  });

  it('emits memberRemoved with the correct member id', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const removeBtn = el.querySelector(
      'mui-list-row button[aria-label="Remove Grace Hopper"]',
    ) as HTMLButtonElement;
    removeBtn.click();
    expect(host.removed).toBe('m2');
  });

  it('emits dismissed on scrim click', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
