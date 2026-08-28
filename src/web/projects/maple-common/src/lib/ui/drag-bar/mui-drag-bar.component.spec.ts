import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MuiDragBarComponent } from './mui-drag-bar.component';

function render(): { fixture: ComponentFixture<MuiDragBarComponent>; bar: HTMLElement } {
  TestBed.configureTestingModule({ imports: [MuiDragBarComponent] });
  const fixture = TestBed.createComponent(MuiDragBarComponent);
  fixture.componentRef.setInput('label', 'Straighten');
  fixture.detectChanges();
  const bar: HTMLElement = fixture.nativeElement.querySelector('.bar');
  bar.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20 }) as DOMRect;
  bar.setPointerCapture = () => {};
  return { fixture, bar };
}

function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, pointerId, bubbles: true });
}

describe('MuiDragBarComponent', () => {
  it('renders 21 ticks with the center one emphasized', () => {
    const { fixture } = render();
    const ticks = fixture.nativeElement.querySelectorAll('.tick');
    expect(ticks.length).toBe(21);
    expect(fixture.nativeElement.querySelectorAll('.tick.emphasized').length).toBe(1);
  });

  it('clicking a position on the bar jumps the value to that position', () => {
    const { fixture, bar } = render();
    // 150/200 = 75% of a [-100, 100] range -> value 50.
    bar.dispatchEvent(pointerEvent('pointerdown', 150));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(50);
  });

  it('dragging continues to update the value from pointer position', () => {
    const { fixture, bar } = render();
    bar.dispatchEvent(pointerEvent('pointerdown', 100)); // center -> 0
    bar.dispatchEvent(pointerEvent('pointermove', 0)); // left edge -> -100
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(-100);
  });

  it('ArrowRight/ArrowLeft nudge the value by one step and stop propagation', () => {
    const { fixture, bar } = render();
    const ancestorHandler: KeyboardEvent[] = [];
    fixture.nativeElement.addEventListener('keydown', (e: KeyboardEvent) =>
      ancestorHandler.push(e),
    );
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(1);
    expect(ancestorHandler.length).toBe(0);
  });

  it('ariaLabel overrides the accessible name without rendering a visible label row', () => {
    const { fixture, bar } = render();
    fixture.componentRef.setInput('label', null);
    fixture.componentRef.setInput('ariaLabel', 'Drag bar marker, value +5');
    fixture.detectChanges();
    expect(bar.getAttribute('aria-label')).toBe('Drag bar marker, value +5');
    expect(fixture.nativeElement.querySelector('.row')).toBeNull();
  });

  it('testId is passed through as the track element’s own data-testid', () => {
    const { fixture, bar } = render();
    fixture.componentRef.setInput('testId', 'crop-straighten');
    fixture.detectChanges();
    expect(bar.getAttribute('data-testid')).toBe('crop-straighten');
  });

  it('disables interaction when disabled', () => {
    const { fixture, bar } = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    bar.dispatchEvent(pointerEvent('pointerdown', 150));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(0);
  });
});

// ── Relative drag mode (#3046) ──────────────────────────────────────────
// The Pro Editor's drag-bar contract: touch-down never jumps the value —
// only the pointer's DELTA from the down point moves it — plus a
// long-press-to-fine-mode gesture and haptics-hook outputs.
describe('MuiDragBarComponent — relative drag mode', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function renderRelative(): { fixture: ComponentFixture<MuiDragBarComponent>; bar: HTMLElement } {
    const rendered = render();
    rendered.fixture.componentRef.setInput('dragMode', 'relative');
    rendered.fixture.componentRef.setInput('value', 20);
    rendered.fixture.detectChanges();
    return rendered;
  }

  it('pointer-down does not move the value', () => {
    const { fixture, bar } = renderRelative();
    bar.dispatchEvent(pointerEvent('pointerdown', 150));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(20);
  });

  it('drag moves the value by the DELTA from the down point, not the raw position', () => {
    const { fixture, bar } = renderRelative();
    bar.dispatchEvent(pointerEvent('pointerdown', 100));
    // +50px on a 200px-wide [-100,100] bar -> +50% of the range -> +50.
    bar.dispatchEvent(pointerEvent('pointermove', 150));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(70); // started at 20
  });

  it('emits dragStart and dragEnd bounding the gesture', () => {
    const { fixture, bar } = renderRelative();
    let starts = 0;
    let ends = 0;
    fixture.componentInstance.dragStart.subscribe(() => starts++);
    fixture.componentInstance.dragEnd.subscribe(() => ends++);

    bar.dispatchEvent(pointerEvent('pointerdown', 100));
    expect(starts).toBe(1);
    expect(ends).toBe(0);
    bar.dispatchEvent(pointerEvent('pointerup', 100));
    expect(ends).toBe(1);
  });

  it('a long hold without movement engages fine mode and scales sensitivity down', () => {
    const { fixture, bar } = renderRelative();
    let engaged = 0;
    fixture.componentInstance.fineModeEngaged.subscribe(() => engaged++);

    bar.dispatchEvent(pointerEvent('pointerdown', 100));
    expect(fixture.componentInstance.fineMode()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(engaged).toBe(1);
    expect(fixture.componentInstance.fineMode()).toBe(true);

    // +50px would normally be +50; fine mode's default 0.25 sensitivity
    // scales it to +12.5.
    bar.dispatchEvent(pointerEvent('pointermove', 150));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(32.5); // 20 + 12.5
  });

  it('movement before the long-press threshold cancels fine mode', () => {
    const { fixture, bar } = renderRelative();
    let engaged = 0;
    fixture.componentInstance.fineModeEngaged.subscribe(() => engaged++);

    bar.dispatchEvent(pointerEvent('pointerdown', 100));
    bar.dispatchEvent(pointerEvent('pointermove', 105)); // clears the timer
    vi.advanceTimersByTime(500);
    expect(engaged).toBe(0);
    expect(fixture.componentInstance.fineMode()).toBe(false);
  });

  it('emits reachedExtreme when the drag carries the value to a bound', () => {
    const { fixture, bar } = renderRelative();
    let extremes = 0;
    fixture.componentInstance.reachedExtreme.subscribe(() => extremes++);

    bar.dispatchEvent(pointerEvent('pointerdown', 100));
    bar.dispatchEvent(pointerEvent('pointermove', -100)); // far past the left edge
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(-100);
    expect(extremes).toBe(1);
  });

  it('emits crossedZero when the drag carries the value across zero', () => {
    const { fixture, bar } = renderRelative();
    fixture.componentRef.setInput('value', 10);
    fixture.detectChanges();
    let crossings = 0;
    fixture.componentInstance.crossedZero.subscribe(() => crossings++);

    bar.dispatchEvent(pointerEvent('pointerdown', 100));
    // -20px on a 200px-wide [-100,100] bar -> -20 -> 10 + (-20) = -10.
    bar.dispatchEvent(pointerEvent('pointermove', 80));
    fixture.detectChanges();
    expect(crossings).toBe(1);
  });
});
