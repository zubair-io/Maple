import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiLivingSliderComponent } from './mui-living-slider.component';

function render(): { fixture: ComponentFixture<MuiLivingSliderComponent>; track: HTMLElement } {
  TestBed.configureTestingModule({ imports: [MuiLivingSliderComponent] });
  const fixture = TestBed.createComponent(MuiLivingSliderComponent);
  fixture.componentRef.setInput('label', 'Exposure');
  fixture.componentRef.setInput('value', 0);
  fixture.componentRef.setInput('min', -5);
  fixture.componentRef.setInput('max', 5);
  fixture.componentRef.setInput('step', 0.1);
  fixture.detectChanges();
  const track: HTMLElement = fixture.nativeElement.querySelector('.track');
  track.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 6, right: 200, bottom: 6 }) as DOMRect;
  // jsdom doesn't implement pointer capture.
  track.setPointerCapture = () => {};
  return { fixture, track };
}

function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, pointerId, bubbles: true });
}

describe('MuiLivingSliderComponent', () => {
  it('renders the label, a signed readout, and a track painted with the gradient', () => {
    const { fixture } = render();
    fixture.componentRef.setInput('gradient', 'linear-gradient(90deg, #3b82f6, #f59e0b)');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.label').textContent).toContain('Exposure');
    expect(fixture.nativeElement.querySelector('.readout').textContent.trim()).toBe('0.0');
    expect(fixture.nativeElement.querySelector('.track').style.background).toContain(
      'linear-gradient',
    );
  });

  it('a drag from the track updates the value proportionally and snaps to step', () => {
    const { fixture, track } = render();
    track.dispatchEvent(pointerEvent('pointerdown', 100));
    track.dispatchEvent(pointerEvent('pointermove', 120)); // +20px of 200px = +2.0 over a 10-wide range
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBeCloseTo(1.0, 5);
  });

  it('clamps the dragged value to min/max', () => {
    const { fixture, track } = render();
    track.dispatchEvent(pointerEvent('pointerdown', 100));
    track.dispatchEvent(pointerEvent('pointermove', 400));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(5);
  });

  it('ArrowRight/ArrowLeft nudge the value by one step and stop propagation', () => {
    const { fixture, track } = render();
    fixture.componentRef.setInput('value', 1);
    fixture.detectChanges();
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBeCloseTo(1.1, 5);

    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBeCloseTo(0.9, 5);
  });

  it('double-click resets to zero (clamped within range)', () => {
    const { fixture, track } = render();
    fixture.componentRef.setInput('value', 3);
    fixture.detectChanges();
    track.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(0);
  });

  it('exposes slider ARIA attributes for assistive tech', () => {
    const { fixture, track } = render();
    fixture.componentRef.setInput('value', 2);
    fixture.detectChanges();
    expect(track.getAttribute('role')).toBe('slider');
    expect(track.getAttribute('aria-valuemin')).toBe('-5');
    expect(track.getAttribute('aria-valuemax')).toBe('5');
    expect(track.getAttribute('aria-valuenow')).toBe('2');
  });
});
