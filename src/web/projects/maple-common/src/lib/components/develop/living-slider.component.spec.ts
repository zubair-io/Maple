// living-slider.component.spec.ts — #2409: arrow-key keyboard operation of
// the focused track (role="slider") must (a) adjust the value and (b) stop
// the event from bubbling to ancestor listeners — otherwise the editor
// shell's global filmstrip-navigation shortcut (bound on `document:keydown`)
// steals the same ArrowLeft/ArrowRight keys and silently switches images
// out from under a keyboard user who thinks they're nudging a slider.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, afterEach } from 'vitest';
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

// living-slider.component.spec.ts — gesture-boundary outputs (#2411).
//
// `valueChange` fires on every pointermove / arrow-key tick, which is right
// for the live preview but wrong for undo: a drag or a key-hold must open
// exactly one undo entry, not one per tick. `dragStart` / `dragEnd` mark the
// gesture boundary so a consumer (ControlCardComponent) can hang a single
// `commit()` off gesture START, before any `valueChange` lands.
describe('LivingSliderComponent — dragStart/dragEnd gesture boundary (#2411)', () => {
  function render(): {
    fixture: ReturnType<typeof TestBed.createComponent<LivingSliderComponent>>;
    slider: LivingSliderComponent;
    track: HTMLElement;
  } {
    TestBed.configureTestingModule({ imports: [LivingSliderComponent] });
    const fixture = TestBed.createComponent(LivingSliderComponent);
    fixture.componentRef.setInput('label', 'Exposure');
    fixture.componentRef.setInput('value', 0);
    fixture.componentRef.setInput('min', -5);
    fixture.componentRef.setInput('max', 5);
    fixture.componentRef.setInput('step', 0.1);
    fixture.detectChanges();
    const track: HTMLElement = fixture.nativeElement.querySelector('.track-wrap');
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20 }) as DOMRect;
    // jsdom doesn't implement pointer capture.
    track.setPointerCapture = () => {};
    track.releasePointerCapture = () => {};
    return { fixture, slider: fixture.componentInstance, track };
  }

  function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
    return new PointerEvent(type, { button: 0, clientX, pointerId, bubbles: true });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pointerdown fires dragStart exactly once, before any valueChange', () => {
    const { slider, track } = render();
    const events: string[] = [];
    slider.dragStart.subscribe(() => events.push('start'));
    slider.valueChange.subscribe(() => events.push('change'));

    track.dispatchEvent(pointerEvent('pointerdown', 0));
    expect(events).toEqual(['start']);

    window.dispatchEvent(pointerEvent('pointermove', 20));
    window.dispatchEvent(pointerEvent('pointermove', 40));
    expect(events.filter((e) => e === 'start').length).toBe(1);
    expect(events.filter((e) => e === 'change').length).toBe(2);
  });

  it('pointerup fires dragEnd exactly once', () => {
    const { slider, track } = render();
    let endCount = 0;
    slider.dragEnd.subscribe(() => endCount++);

    track.dispatchEvent(pointerEvent('pointerdown', 0));
    window.dispatchEvent(pointerEvent('pointermove', 20));
    window.dispatchEvent(pointerEvent('pointerup', 20));

    expect(endCount).toBe(1);
  });

  it('pointercancel also closes the gesture with dragEnd', () => {
    const { slider, track } = render();
    let endCount = 0;
    slider.dragEnd.subscribe(() => endCount++);

    track.dispatchEvent(pointerEvent('pointerdown', 0));
    window.dispatchEvent(pointerEvent('pointercancel', 10));

    expect(endCount).toBe(1);
  });

  it('a second drag after dragEnd opens a fresh dragStart', () => {
    const { slider, track } = render();
    let startCount = 0;
    slider.dragStart.subscribe(() => startCount++);

    track.dispatchEvent(pointerEvent('pointerdown', 0));
    window.dispatchEvent(pointerEvent('pointerup', 0));
    track.dispatchEvent(pointerEvent('pointerdown', 0));
    window.dispatchEvent(pointerEvent('pointerup', 0));

    expect(startCount).toBe(2);
  });

  // Multi-touch re-entrancy (PR #2418 review): a second finger's pointerdown
  // mid-drag must not open a second gesture — an extra dragStart would push
  // an extra undo commit for one interaction, and overwriting _boundPointer*
  // without removing the old handlers would leak window listeners.
  it('a second pointerdown mid-drag is ignored — dragStart fires once', () => {
    const { slider, track } = render();
    const events: string[] = [];
    slider.dragStart.subscribe(() => events.push('start'));
    slider.dragEnd.subscribe(() => events.push('end'));

    track.dispatchEvent(pointerEvent('pointerdown', 0, 1));
    track.dispatchEvent(pointerEvent('pointerdown', 80, 2)); // second finger
    window.dispatchEvent(pointerEvent('pointerup', 20, 1));

    expect(events).toEqual(['start', 'end']);
  });

  it('only the active pointer ends the gesture; other pointers cannot', () => {
    const { slider, track } = render();
    track.dispatchEvent(pointerEvent('pointerdown', 0, 1));

    window.dispatchEvent(pointerEvent('pointerup', 50, 2)); // stray pointer
    expect(slider.dragging()).toBe(true);

    window.dispatchEvent(pointerEvent('pointerup', 20, 1));
    expect(slider.dragging()).toBe(false);
  });

  it('moves from a non-active pointer do not drive the value', () => {
    const { slider, track } = render();
    let changeCount = 0;
    slider.valueChange.subscribe(() => changeCount++);

    track.dispatchEvent(pointerEvent('pointerdown', 0, 1));
    window.dispatchEvent(pointerEvent('pointermove', 40, 2)); // stray pointer
    expect(changeCount).toBe(0);

    window.dispatchEvent(pointerEvent('pointermove', 40, 1));
    expect(changeCount).toBe(1);
    window.dispatchEvent(pointerEvent('pointerup', 40, 1));
  });

  it('every window listener added by a drag is removed on release, even with a mid-drag pointerdown', () => {
    const { track } = render();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    track.dispatchEvent(pointerEvent('pointerdown', 0, 1));
    track.dispatchEvent(pointerEvent('pointerdown', 80, 2)); // re-entrant down
    window.dispatchEvent(pointerEvent('pointerup', 20, 1));

    const pointerTypes = ['pointermove', 'pointerup', 'pointercancel'];
    const added = addSpy.mock.calls.filter(([type]) => pointerTypes.includes(type as string));
    const removed = removeSpy.mock.calls.filter(([type]) => pointerTypes.includes(type as string));
    expect(added.length).toBe(3); // one set of listeners, not two
    expect(removed.length).toBe(3);
    // The exact handler references that were added are the ones removed.
    const addedFns = added.map(([, fn]) => fn);
    const removedFns = removed.map(([, fn]) => fn);
    expect(new Set(removedFns)).toEqual(new Set(addedFns));
  });

  it('a held arrow key (repeated keydown) opens ONE dragStart, closed by keyup', () => {
    const { slider, track } = render();
    const events: string[] = [];
    slider.dragStart.subscribe(() => events.push('start'));
    slider.dragEnd.subscribe(() => events.push('end'));
    slider.valueChange.subscribe(() => events.push('change'));

    // Browser key-repeat: first keydown has repeat:false, the rest repeat:true.
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    track.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }),
    );
    track.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }),
    );
    track.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));

    expect(events).toEqual(['start', 'change', 'change', 'change', 'end']);
  });

  it('two separate key presses open two dragStart/dragEnd pairs', () => {
    const { slider, track } = render();
    let startCount = 0;
    let endCount = 0;
    slider.dragStart.subscribe(() => startCount++);
    slider.dragEnd.subscribe(() => endCount++);

    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    track.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    track.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));

    expect(startCount).toBe(2);
    expect(endCount).toBe(2);
  });

  it('a non-arrow key does not open a gesture', () => {
    const { slider, track } = render();
    let startCount = 0;
    slider.dragStart.subscribe(() => startCount++);

    track.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

    expect(startCount).toBe(0);
  });
});
