import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiPad2dComponent } from './mui-pad-2d.component';

function render(): { fixture: ComponentFixture<MuiPad2dComponent>; pad: HTMLElement } {
  TestBed.configureTestingModule({ imports: [MuiPad2dComponent] });
  const fixture = TestBed.createComponent(MuiPad2dComponent);
  fixture.detectChanges();
  const pad: HTMLElement = fixture.nativeElement.querySelector('.mui-pad-2d');
  pad.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
  pad.setPointerCapture = () => {};
  return { fixture, pad };
}

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, clientY, pointerId, bubbles: true });
}

describe('MuiPad2dComponent', () => {
  it('clicking the top-left corner sets x -1, y 1', () => {
    const { fixture, pad } = render();
    pad.dispatchEvent(pointerEvent('pointerdown', 0, 0));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ x: -1, y: 1 });
  });

  it('clicking the center sets x 0, y 0', () => {
    const { fixture, pad } = render();
    pad.dispatchEvent(pointerEvent('pointerdown', 50, 50));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ x: 0, y: 0 });
  });

  it('clicking the bottom-right corner sets x 1, y -1', () => {
    const { fixture, pad } = render();
    pad.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ x: 1, y: -1 });
  });

  it('dragging continues to update the value', () => {
    const { fixture, pad } = render();
    pad.dispatchEvent(pointerEvent('pointerdown', 50, 50));
    pad.dispatchEvent(pointerEvent('pointermove', 100, 0));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ x: 1, y: 1 });
  });

  it('arrow keys nudge x and y by a fixed step, clamped to [-1, 1]', () => {
    const { fixture, pad } = render();
    fixture.componentRef.setInput('value', { x: 0.98, y: 0 });
    fixture.detectChanges();

    pad.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value().x).toBe(1);

    pad.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value().y).toBeCloseTo(0.05, 5);
  });

  it('ignores drag and keyboard when disabled', () => {
    const { fixture, pad } = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    pad.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ x: 0, y: 0 });
  });
});
