import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiEventPopoverComponent } from './mui-event-popover.component';

@Component({
  standalone: true,
  imports: [MuiEventPopoverComponent],
  template: `
    <div style="position: relative">
      <mui-event-popover
        [open]="open()"
        title="Design review"
        timeLabel="3:00 PM"
        (closeRequested)="open.set(false)"
        (saved)="savedCount = savedCount + 1"
        (deleted)="deletedCount = deletedCount + 1"
      />
    </div>
  `,
})
class HostComponent {
  readonly open = signal(true);
  savedCount = 0;
  deletedCount = 0;
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

describe('MuiEventPopoverComponent', () => {
  it('renders the title/time fields (as input values, not text) while open', () => {
    const fixture = render();
    const controls = fixture.nativeElement.querySelectorAll(
      '.control',
    ) as NodeListOf<HTMLInputElement>;
    expect(controls[0].value).toBe('Design review');
    expect(controls[1].value).toBe('3:00 PM');
  });

  it('renders nothing when closed', () => {
    const fixture = render();
    fixture.componentInstance.open.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-event-popover')).toBeNull();
  });

  it('emits saved and deleted from their respective buttons', () => {
    const fixture = render();
    const buttons = fixture.nativeElement.querySelectorAll('.actions .mui-button');
    (buttons[0] as HTMLButtonElement).click(); // Delete
    expect(fixture.componentInstance.deletedCount).toBe(1);
    (buttons[1] as HTMLButtonElement).click(); // Save
    expect(fixture.componentInstance.savedCount).toBe(1);
  });

  it('outside click requests close via the popover primitive', async () => {
    const fixture = render();
    // mui-popover defers attaching its document listeners by one macrotask
    // (see mui-popover.component.ts) so the click that opened it doesn't
    // immediately close it — wait that same tick out before dispatching.
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.open()).toBe(false);
  });
});
