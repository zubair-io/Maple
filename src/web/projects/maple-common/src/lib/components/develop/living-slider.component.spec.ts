// living-slider.component.spec.ts — #2409: arrow-key keyboard operation of
// the focused track (role="slider") must (a) adjust the value and (b) stop
// the event from bubbling to ancestor listeners — otherwise the editor
// shell's global filmstrip-navigation shortcut (bound on `document:keydown`)
// steals the same ArrowLeft/ArrowRight keys and silently switches images
// out from under a keyboard user who thinks they're nudging a slider.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { LivingSliderComponent } from './living-slider.component';

function createTrack(
  overrides: Partial<{ value: number; min: number; max: number; step: number }> = {},
) {
  const fixture = TestBed.createComponent(LivingSliderComponent);
  fixture.componentRef.setInput('label', 'Exposure');
  fixture.componentRef.setInput('value', overrides.value ?? 0);
  fixture.componentRef.setInput('min', overrides.min ?? -100);
  fixture.componentRef.setInput('max', overrides.max ?? 100);
  fixture.componentRef.setInput('step', overrides.step ?? 1);
  fixture.detectChanges();
  const host: HTMLElement = fixture.nativeElement;
  const track = host.querySelector<HTMLElement>('.track-wrap')!;
  return { fixture, host, track };
}

describe('LivingSliderComponent — keyboard operation (#2409)', () => {
  it('renders the track as a focusable role="slider" widget', () => {
    const { track } = createTrack();
    expect(track.getAttribute('role')).toBe('slider');
    expect(track.getAttribute('tabindex')).toBe('0');
  });

  it('ArrowRight increments the value by one step', () => {
    const { fixture, track } = createTrack({ value: 10, step: 1 });
    const emitted: number[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    track.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    expect(emitted).toEqual([11]);
  });

  it('ArrowLeft decrements the value by one step', () => {
    const { fixture, track } = createTrack({ value: 10, step: 1 });
    const emitted: number[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    track.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    expect(emitted).toEqual([9]);
  });

  it('ArrowRight/ArrowLeft stop propagation so an ancestor keydown listener never sees them (#2409)', () => {
    const { host, track } = createTrack({ value: 10, step: 1 });
    const ancestorHandler = vi.fn();
    host.addEventListener('keydown', ancestorHandler);

    track.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    track.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );

    expect(ancestorHandler).not.toHaveBeenCalled();
  });

  it('a key the slider does not consume (e.g. Tab) is left alone and still bubbles', () => {
    const { fixture, host, track } = createTrack({ value: 10, step: 1 });
    const emitted: number[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    const ancestorHandler = vi.fn();
    host.addEventListener('keydown', ancestorHandler);

    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    track.dispatchEvent(ev);

    expect(emitted).toEqual([]);
    expect(ancestorHandler).toHaveBeenCalledTimes(1);
  });

  it('clamps at the max and does not exceed it on ArrowUp', () => {
    const { fixture, track } = createTrack({ value: 100, min: -100, max: 100, step: 1 });
    const emitted: number[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));
    track.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    expect(emitted).toEqual([100]);
  });
});
