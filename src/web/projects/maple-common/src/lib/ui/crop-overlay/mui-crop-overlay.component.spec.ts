import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCropOverlayComponent } from './mui-crop-overlay.component';
import type { MuiCropRect } from './mui-crop-overlay.component';

@Component({
  standalone: true,
  imports: [MuiCropOverlayComponent],
  template: `
    <mui-crop-overlay
      [containerSize]="containerSize"
      [minSize]="20"
      [(rect)]="rect"
      (committed)="commits.push($event)"
    />
  `,
})
class HostComponent {
  readonly containerSize = { width: 300, height: 200 };
  rect: MuiCropRect = { x: 40, y: 40, width: 100, height: 80 };
  commits: MuiCropRect[] = [];
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, clientY, pointerId, bubbles: true });
}

function handle(fixture: ComponentFixture<HostComponent>, id: string): HTMLElement {
  const el = fixture.nativeElement.querySelector(`.handle-${id}`) as HTMLElement;
  el.setPointerCapture = () => {};
  return el;
}

describe('MuiCropOverlayComponent', () => {
  it('renders 8 handles', () => {
    const { fixture } = render();
    expect(fixture.nativeElement.querySelectorAll('.handle').length).toBe(8);
  });

  it('dragging the se (bottom-right) handle grows width/height by the drag delta', () => {
    const { fixture, host } = render();
    const se = handle(fixture, 'se');

    se.dispatchEvent(pointerEvent('pointerdown', 140, 120)); // rect right/bottom = 140,120
    se.dispatchEvent(pointerEvent('pointermove', 170, 150)); // +30, +30
    fixture.detectChanges();

    expect(host.rect).toEqual({ x: 40, y: 40, width: 130, height: 110 });
  });

  it('dragging the nw (top-left) handle moves x/y and shrinks width/height', () => {
    const { fixture, host } = render();
    const nw = handle(fixture, 'nw');

    nw.dispatchEvent(pointerEvent('pointerdown', 40, 40));
    nw.dispatchEvent(pointerEvent('pointermove', 60, 55)); // +20, +15
    fixture.detectChanges();

    expect(host.rect).toEqual({ x: 60, y: 55, width: 80, height: 65 });
  });

  it('emits committed once on pointerup, not during pointermove', () => {
    const { fixture, host } = render();
    const se = handle(fixture, 'se');

    se.dispatchEvent(pointerEvent('pointerdown', 140, 120));
    se.dispatchEvent(pointerEvent('pointermove', 170, 150));
    fixture.detectChanges();
    expect(host.commits.length).toBe(0);

    se.dispatchEvent(pointerEvent('pointerup', 170, 150));
    fixture.detectChanges();
    expect(host.commits.length).toBe(1);
    expect(host.commits[0]).toEqual(host.rect);
  });

  it('a resize drag never shrinks the rect below minSize on either axis', () => {
    const { fixture, host } = render();
    const se = handle(fixture, 'se');

    se.dispatchEvent(pointerEvent('pointerdown', 140, 120));
    se.dispatchEvent(pointerEvent('pointermove', -500, -500)); // drag far past the top-left anchor
    fixture.detectChanges();

    expect(host.rect.width).toBe(20); // minSize
    expect(host.rect.height).toBe(20);
  });

  it('a resize drag never pushes the rect outside the container bounds', () => {
    const { fixture, host } = render();
    const se = handle(fixture, 'se');

    se.dispatchEvent(pointerEvent('pointerdown', 140, 120));
    se.dispatchEvent(pointerEvent('pointermove', 5000, 5000)); // drag far past the container edge
    fixture.detectChanges();

    expect(host.rect.x + host.rect.width).toBe(300); // containerSize.width
    expect(host.rect.y + host.rect.height).toBe(200); // containerSize.height
  });

  it('ArrowRight on a focused handle nudges the rect by 1px and emits committed', () => {
    const { fixture, host } = render();
    const e = handle(fixture, 'e');

    e.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();

    expect(host.rect).toEqual({ x: 40, y: 40, width: 101, height: 80 });
    expect(host.commits.length).toBe(1);
  });

  it('Shift+ArrowRight nudges by 10px instead of 1px', () => {
    const { fixture, host } = render();
    const e = handle(fixture, 'e');

    e.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    fixture.detectChanges();

    expect(host.rect.width).toBe(110);
  });

  it('ArrowDown on the s handle grows height without moving x', () => {
    const { fixture, host } = render();
    const s = handle(fixture, 's');

    s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();

    expect(host.rect).toEqual({ x: 40, y: 40, width: 100, height: 81 });
  });
});
