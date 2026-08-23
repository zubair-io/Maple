import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiOverlayShellComponent } from './mui-overlay-shell.component';

@Component({
  standalone: true,
  imports: [MuiOverlayShellComponent],
  template: `
    <mui-overlay-shell
      [open]="open()"
      [size]="'lg'"
      ariaLabel="Export"
      [contained]="contained()"
      (dismissed)="dismissedCount = dismissedCount + 1"
    >
      <div slot="header" class="header-probe">Export</div>
      <div class="body-probe">
        <button type="button" class="first-btn">First</button>
        <button type="button" class="last-btn">Last</button>
      </div>
      <div slot="footer" class="footer-probe">Actions</div>
    </mui-overlay-shell>
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly contained = signal(false);
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiOverlayShellComponent', () => {
  it('renders nothing when closed', () => {
    const { fixture, host } = render();
    host.open.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-overlay-shell-scrim')).toBeNull();
  });

  it('projects header, body, and footer into their own regions', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.header .header-probe')).not.toBeNull();
    expect(el.querySelector('.body .body-probe')).not.toBeNull();
    expect(el.querySelector('.footer .footer-probe')).not.toBeNull();
  });

  it('applies the size class', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.mui-overlay-shell.size-lg')).not.toBeNull();
  });

  it('emits dismissed on scrim click and Escape, not on a click inside the panel', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-overlay-shell') as HTMLElement).click();
    expect(host.dismissedCount).toBe(0);

    (fixture.nativeElement.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(host.dismissedCount).toBe(2);
  });

  it('wraps Tab from the last focusable to the first, and Shift+Tab back', () => {
    const { fixture } = render();
    const first = fixture.nativeElement.querySelector('.first-btn') as HTMLButtonElement;
    const last = fixture.nativeElement.querySelector('.last-btn') as HTMLButtonElement;

    last.focus();
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    first.focus();
    const shiftTabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    document.dispatchEvent(shiftTabEvent);
    expect(shiftTabEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('renders in contained mode without the fixed scrim class', () => {
    const { fixture, host } = render();
    host.contained.set(true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.mui-overlay-shell-scrim.contained'),
    ).not.toBeNull();
  });
});
