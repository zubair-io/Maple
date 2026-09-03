import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPopoverComponent } from './mui-popover.component';

@Component({
  standalone: true,
  imports: [MuiPopoverComponent],
  template: `
    <div style="position: relative">
      <button type="button">Trigger</button>
      <mui-popover [open]="open()" placement="bottom" (closeRequested)="closeRequested()">
        <button type="button" class="inside">Inside</button>
      </mui-popover>
    </div>
  `,
})
class HostComponent {
  readonly open = signal(false);
  closeCount = 0;
  closeRequested(): void {
    this.closeCount++;
  }
}

// A popover whose content names its own entry point — the Command Menu's
// search field is the real case.
@Component({
  standalone: true,
  imports: [MuiPopoverComponent],
  template: `
    <div style="position: relative">
      <mui-popover [open]="open()">
        <input type="text" autofocus />
      </mui-popover>
    </div>
  `,
})
class AutofocusHostComponent {
  readonly open = signal(false);
}

function render(): ComponentFixture<HostComponent> {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return fixture;
}

async function flushOpenTimer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MuiPopoverComponent', () => {
  it('renders nothing while closed and the panel once open, with the placement class applied', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelector('.mui-popover')).toBeNull();

    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('.mui-popover');
    expect(panel).toBeTruthy();
    expect(panel.className).toContain('placement-bottom');
  });

  it('emits closeRequested on an outside click but not an inside click', async () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await flushOpenTimer();

    fixture.nativeElement
      .querySelector('.inside')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fixture.componentInstance.closeCount).toBe(0);

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fixture.componentInstance.closeCount).toBe(1);
  });

  it('emits closeRequested on Escape', async () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await flushOpenTimer();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(fixture.componentInstance.closeCount).toBe(1);
  });

  it('moves focus onto the panel once opened', async () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await Promise.resolve();
    const panel = fixture.nativeElement.querySelector('.mui-popover');
    expect(document.activeElement).toBe(panel);
  });

  it('gives focus to an [autofocus] child instead of the bare panel', async () => {
    TestBed.configureTestingModule({ imports: [AutofocusHostComponent] });
    const fixture = TestBed.createComponent(AutofocusHostComponent);
    fixture.detectChanges();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await Promise.resolve();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('input'));
  });

  it('stops reacting to document clicks once closed again', async () => {
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();
    await flushOpenTimer();

    fixture.componentInstance.open.set(false);
    fixture.detectChanges();

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fixture.componentInstance.closeCount).toBe(0);
  });
});
