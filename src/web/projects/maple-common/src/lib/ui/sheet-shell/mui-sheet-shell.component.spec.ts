import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiSheetShellComponent } from './mui-sheet-shell.component';

@Component({
  standalone: true,
  imports: [MuiSheetShellComponent],
  template: `
    <mui-sheet-shell
      [open]="open()"
      [detents]="detents"
      [(activeDetent)]="activeDetent"
      [contained]="contained()"
      (dismissed)="dismissedCount = dismissedCount + 1"
    >
      <div class="body-probe">Body</div>
    </mui-sheet-shell>
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly contained = signal(false);
  readonly detents = [0.4, 0.9];
  readonly activeDetent = signal(0);
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function pointerEvent(type: string, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientY, pointerId, bubbles: true });
}

describe('MuiSheetShellComponent', () => {
  it('renders nothing when closed', () => {
    const { fixture, host } = render();
    host.open.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-sheet-shell')).toBeNull();
  });

  it('projects body content and renders the grab handle', () => {
    const { fixture } = render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.body .body-probe')).not.toBeNull();
    expect(el.querySelector('.grab-handle')).not.toBeNull();
  });

  it('sets sheet height from the active detent fraction', () => {
    const { fixture, host } = render();
    let sheet = fixture.nativeElement.querySelector('.mui-sheet-shell') as HTMLElement;
    expect(sheet.style.height).toBe('40%');

    host.activeDetent.set(1);
    fixture.detectChanges();
    sheet = fixture.nativeElement.querySelector('.mui-sheet-shell') as HTMLElement;
    expect(sheet.style.height).toBe('90%');
  });

  it('emits dismissed on scrim click and Escape', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-sheet-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(host.dismissedCount).toBe(2);
  });

  it('dismisses on a pan-down drag past 25% of the sheet height', () => {
    const { fixture, host } = render();
    const sheet = fixture.nativeElement.querySelector('.mui-sheet-shell') as HTMLElement;
    sheet.getBoundingClientRect = () =>
      ({ height: 400, top: 0, left: 0, width: 300, right: 300, bottom: 400 }) as DOMRect;
    const dragArea = fixture.nativeElement.querySelector('.drag-area') as HTMLElement;
    dragArea.setPointerCapture = () => {};

    dragArea.dispatchEvent(pointerEvent('pointerdown', 100));
    dragArea.dispatchEvent(pointerEvent('pointermove', 170)); // +70px < 25% of 400
    dragArea.dispatchEvent(pointerEvent('pointerup', 170));
    expect(host.dismissedCount).toBe(0);

    dragArea.dispatchEvent(pointerEvent('pointerdown', 100));
    dragArea.dispatchEvent(pointerEvent('pointermove', 250)); // +150px >= 25% of 400
    dragArea.dispatchEvent(pointerEvent('pointerup', 250));
    expect(host.dismissedCount).toBe(1);
  });

  it('does not dismiss on a short drag that snaps back', () => {
    const { fixture, host } = render();
    const sheet = fixture.nativeElement.querySelector('.mui-sheet-shell') as HTMLElement;
    sheet.getBoundingClientRect = () =>
      ({ height: 400, top: 0, left: 0, width: 300, right: 300, bottom: 400 }) as DOMRect;
    const dragArea = fixture.nativeElement.querySelector('.drag-area') as HTMLElement;
    dragArea.setPointerCapture = () => {};

    dragArea.dispatchEvent(pointerEvent('pointerdown', 100));
    dragArea.dispatchEvent(pointerEvent('pointermove', 120));
    dragArea.dispatchEvent(pointerEvent('pointerup', 120));
    fixture.detectChanges();
    expect(host.dismissedCount).toBe(0);
    expect(
      (fixture.nativeElement.querySelector('.mui-sheet-shell') as HTMLElement).style.transform,
    ).toBe('translateY(0px)');
  });

  it('renders in contained mode without the fixed-position scrim class', () => {
    const { fixture, host } = render();
    host.contained.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-sheet-shell-scrim.contained')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.mui-sheet-shell.contained')).not.toBeNull();
  });
});
