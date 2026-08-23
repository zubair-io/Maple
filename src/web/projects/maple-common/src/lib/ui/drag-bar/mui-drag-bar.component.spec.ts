import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

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

  it('disables interaction when disabled', () => {
    const { fixture, bar } = render();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    bar.dispatchEvent(pointerEvent('pointerdown', 150));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(0);
  });
});
