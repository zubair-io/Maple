import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiColorWheelComponent } from './mui-color-wheel.component';

function render(): { fixture: ComponentFixture<MuiColorWheelComponent>; wheel: HTMLElement } {
  TestBed.configureTestingModule({ imports: [MuiColorWheelComponent] });
  const fixture = TestBed.createComponent(MuiColorWheelComponent);
  fixture.detectChanges();
  const wheel: HTMLElement = fixture.nativeElement.querySelector('.mui-color-wheel');
  wheel.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }) as DOMRect;
  wheel.setPointerCapture = () => {};
  return { fixture, wheel };
}

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, clientY, pointerId, bubbles: true });
}

describe('MuiColorWheelComponent', () => {
  it('dragging to the rightmost edge (center-y) sets hue 0, full saturation', () => {
    const { fixture, wheel } = render();
    wheel.dispatchEvent(pointerEvent('pointerdown', 100, 50));
    fixture.detectChanges();
    const value = fixture.componentInstance.value();
    expect(value.hue).toBe(0);
    expect(value.saturation).toBe(100);
  });

  it('dragging to the wheel center sets saturation 0', () => {
    const { fixture, wheel } = render();
    wheel.dispatchEvent(pointerEvent('pointerdown', 50, 50));
    fixture.detectChanges();
    expect(fixture.componentInstance.value().saturation).toBe(0);
  });

  it('a position outside the disc clamps to the rim (saturation 100)', () => {
    const { fixture, wheel } = render();
    wheel.dispatchEvent(pointerEvent('pointerdown', 1000, 50));
    fixture.detectChanges();
    expect(fixture.componentInstance.value().saturation).toBe(100);
  });

  it('pointermove continues to update the value while dragging', () => {
    const { fixture, wheel } = render();
    wheel.dispatchEvent(pointerEvent('pointerdown', 100, 50));
    wheel.dispatchEvent(pointerEvent('pointermove', 50, 0)); // top -> hue 90
    fixture.detectChanges();
    expect(fixture.componentInstance.value().hue).toBe(90);
  });

  it('places the puck at geometrically correct box coordinates', () => {
    // hue 0 (right edge, center row), full saturation -> left 100%, top 50%.
    const { fixture } = render();
    fixture.componentRef.setInput('value', { hue: 0, saturation: 100 });
    fixture.detectChanges();
    expect(fixture.componentInstance.puckPos()).toEqual({ left: 100, top: 50 });
    // hue 90 (straight up) -> top 0%; hue 270 (straight down) -> top 100%.
    fixture.componentRef.setInput('value', { hue: 90, saturation: 100 });
    fixture.detectChanges();
    expect(fixture.componentInstance.puckPos().top).toBeCloseTo(0, 5);
    fixture.componentRef.setInput('value', { hue: 270, saturation: 100 });
    fixture.detectChanges();
    expect(fixture.componentInstance.puckPos().top).toBeCloseTo(100, 5);
    // center (saturation 0) -> dead center.
    fixture.componentRef.setInput('value', { hue: 0, saturation: 0 });
    fixture.detectChanges();
    expect(fixture.componentInstance.puckPos()).toEqual({ left: 50, top: 50 });
  });

  it('arrow keys nudge hue (left/right) and saturation (up/down)', () => {
    const { fixture, wheel } = render();
    fixture.componentRef.setInput('value', { hue: 10, saturation: 50 });
    fixture.detectChanges();

    wheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ hue: 11, saturation: 50 });

    wheel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ hue: 11, saturation: 51 });
  });

  it('does not respond to drag or keyboard when disabled', () => {
    const { fixture, wheel } = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.componentRef.setInput('value', { hue: 0, saturation: 0 });
    fixture.detectChanges();
    wheel.dispatchEvent(pointerEvent('pointerdown', 100, 50));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toEqual({ hue: 0, saturation: 0 });
  });
});
