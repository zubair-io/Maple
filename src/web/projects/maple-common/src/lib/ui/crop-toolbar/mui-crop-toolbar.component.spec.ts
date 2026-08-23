import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiCropToolbarComponent } from './mui-crop-toolbar.component';

function render(): ComponentFixture<MuiCropToolbarComponent> {
  TestBed.configureTestingModule({ imports: [MuiCropToolbarComponent] });
  const fixture = TestBed.createComponent(MuiCropToolbarComponent);
  fixture.detectChanges();
  return fixture;
}

function pointerEvent(type: string, clientX: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, pointerId, bubbles: true });
}

describe('MuiCropToolbarComponent', () => {
  it('renders the four aspect presets and the straighten bar', () => {
    const fixture = render();
    expect(fixture.nativeElement.querySelectorAll('.chip').length).toBe(4);
    expect(fixture.nativeElement.querySelector('.bar')).toBeTruthy();
  });

  it('selecting an aspect chip updates the model and emits aspectChanged', () => {
    const fixture = render();
    const emitted: string[] = [];
    fixture.componentInstance.aspectChanged.subscribe((id) => emitted.push(id));

    const chips = fixture.nativeElement.querySelectorAll('.chip');
    (chips[1] as HTMLButtonElement).click(); // '1:1'
    fixture.detectChanges();

    expect(fixture.componentInstance.aspect()).toBe('1:1');
    expect(emitted).toEqual(['1:1']);
  });

  it('dragging the straighten bar updates the angle model and emits angleChanged', () => {
    const fixture = render();
    const emitted: number[] = [];
    fixture.componentInstance.angleChanged.subscribe((a) => emitted.push(a));

    const bar: HTMLElement = fixture.nativeElement.querySelector('.bar');
    bar.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20 }) as DOMRect;
    bar.setPointerCapture = () => {};

    // 180/200 = 90% of a [-45, 45] range -> round(-45 + 0.9*90) = 36.
    bar.dispatchEvent(pointerEvent('pointerdown', 180));
    fixture.detectChanges();

    expect(fixture.componentInstance.angle()).toBe(36);
    expect(emitted).toEqual([36]);
  });

  it('pressing Reset restores both models to their defaults and emits all three events', () => {
    const fixture = render();
    fixture.componentRef.setInput('aspect', '4:5');
    fixture.componentRef.setInput('angle', 12);
    fixture.detectChanges();

    let resetCount = 0;
    const aspectEmitted: string[] = [];
    const angleEmitted: number[] = [];
    fixture.componentInstance.resetRequested.subscribe(() => (resetCount += 1));
    fixture.componentInstance.aspectChanged.subscribe((id) => aspectEmitted.push(id));
    fixture.componentInstance.angleChanged.subscribe((a) => angleEmitted.push(a));

    (fixture.nativeElement.querySelector('.mui-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.aspect()).toBe('free');
    expect(fixture.componentInstance.angle()).toBe(0);
    expect(resetCount).toBe(1);
    expect(aspectEmitted).toEqual(['free']);
    expect(angleEmitted).toEqual([0]);
  });
});
