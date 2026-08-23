import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiDrawerShellComponent } from './mui-drawer-shell.component';

@Component({
  standalone: true,
  imports: [MuiDrawerShellComponent],
  template: `
    <mui-drawer-shell
      [(open)]="open"
      [edge]="edge()"
      [width]="280"
      [contained]="contained()"
      (dismissed)="dismissedCount = dismissedCount + 1"
    >
      <div class="panel-probe">Panel</div>
    </mui-drawer-shell>
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly edge = signal<'left' | 'right'>('left');
  readonly contained = signal(false);
  dismissedCount = 0;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, pointerId, bubbles: true });
}

describe('MuiDrawerShellComponent', () => {
  it('renders nothing when closed', () => {
    const { fixture, host } = render();
    host.open.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-drawer-shell')).toBeNull();
  });

  it('projects panel content', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('.panel-probe')).not.toBeNull();
  });

  it('sets the panel width from the width input', () => {
    const { fixture } = render();
    const panel = fixture.nativeElement.querySelector('.mui-drawer-shell') as HTMLElement;
    expect(panel.style.width).toBe('280px');
  });

  it('applies the right edge class when edge is "right"', () => {
    const { fixture, host } = render();
    host.edge.set('right');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-drawer-shell.right')).not.toBeNull();
  });

  it('closes the open model and emits dismissed on scrim click', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-drawer-shell-scrim') as HTMLElement).click();
    fixture.detectChanges();
    expect(host.open()).toBe(false);
    expect(host.dismissedCount).toBe(1);
  });

  it('closes on Escape', () => {
    const { fixture, host } = render();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(host.open()).toBe(false);
    expect(host.dismissedCount).toBe(1);
  });

  it('closes on a leftward pan past 30% of the panel width (left edge)', () => {
    const { fixture, host } = render();
    const panel = fixture.nativeElement.querySelector('.mui-drawer-shell') as HTMLElement;
    panel.getBoundingClientRect = () =>
      ({ width: 280, height: 600, top: 0, left: 0, right: 280, bottom: 600 }) as DOMRect;
    panel.setPointerCapture = () => {};
    panel.releasePointerCapture = () => {};

    panel.dispatchEvent(pointerEvent('pointerdown', 200));
    panel.dispatchEvent(pointerEvent('pointermove', 100)); // -100px, 36% of 280
    panel.dispatchEvent(pointerEvent('pointerup', 100));
    fixture.detectChanges();

    expect(host.open()).toBe(false);
    expect(host.dismissedCount).toBe(1);
  });

  it('snaps back (does not close) on a short pan', () => {
    const { fixture, host } = render();
    const panel = fixture.nativeElement.querySelector('.mui-drawer-shell') as HTMLElement;
    panel.getBoundingClientRect = () =>
      ({ width: 280, height: 600, top: 0, left: 0, right: 280, bottom: 600 }) as DOMRect;
    panel.setPointerCapture = () => {};
    panel.releasePointerCapture = () => {};

    panel.dispatchEvent(pointerEvent('pointerdown', 200));
    panel.dispatchEvent(pointerEvent('pointermove', 180)); // -20px, well under 30%
    panel.dispatchEvent(pointerEvent('pointerup', 180));
    fixture.detectChanges();

    expect(host.open()).toBe(true);
    expect(host.dismissedCount).toBe(0);
  });

  it('ignores a rightward drag on a left-edge drawer (wrong direction is a no-op)', () => {
    const { fixture, host } = render();
    const panel = fixture.nativeElement.querySelector('.mui-drawer-shell') as HTMLElement;
    panel.getBoundingClientRect = () =>
      ({ width: 280, height: 600, top: 0, left: 0, right: 280, bottom: 600 }) as DOMRect;
    panel.setPointerCapture = () => {};
    panel.releasePointerCapture = () => {};

    panel.dispatchEvent(pointerEvent('pointerdown', 200));
    panel.dispatchEvent(pointerEvent('pointermove', 400)); // +200px, wrong direction
    panel.dispatchEvent(pointerEvent('pointerup', 400));
    fixture.detectChanges();

    expect(host.open()).toBe(true);
    expect(host.dismissedCount).toBe(0);
  });

  it('renders in contained mode without the fixed-position scrim class', () => {
    const { fixture, host } = render();
    host.contained.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.mui-drawer-shell-scrim.contained')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.mui-drawer-shell.contained')).not.toBeNull();
  });
});
