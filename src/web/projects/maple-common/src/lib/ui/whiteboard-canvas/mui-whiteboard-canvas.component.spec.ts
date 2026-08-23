import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiWhiteboardCanvasComponent } from './mui-whiteboard-canvas.component';

function render(): {
  fixture: ComponentFixture<MuiWhiteboardCanvasComponent>;
  canvas: HTMLCanvasElement;
} {
  TestBed.configureTestingModule({ imports: [MuiWhiteboardCanvasComponent] });
  const fixture = TestBed.createComponent(MuiWhiteboardCanvasComponent);
  fixture.detectChanges();
  const canvas: HTMLCanvasElement = fixture.nativeElement.querySelector('canvas');
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 }) as DOMRect;
  canvas.setPointerCapture = () => {};
  return { fixture, canvas };
}

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { button: 0, clientX, clientY, pointerId, bubbles: true });
}

describe('MuiWhiteboardCanvasComponent', () => {
  it('a pen drag commits exactly one stroke with the dragged points', () => {
    const { fixture, canvas } = render();
    expect(fixture.componentInstance.strokes().length).toBe(0);

    canvas.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    canvas.dispatchEvent(pointerEvent('pointermove', 20, 15));
    canvas.dispatchEvent(pointerEvent('pointermove', 30, 25));
    canvas.dispatchEvent(pointerEvent('pointerup', 30, 25));
    fixture.detectChanges();

    const strokes = fixture.componentInstance.strokes();
    expect(strokes.length).toBe(1);
    expect(strokes[0].tool).toBe('pen');
    expect(strokes[0].points).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 15 },
      { x: 30, y: 25 },
    ]);
  });

  it('switching to the eraser and dragging over a stroke point removes that stroke', () => {
    const { fixture, canvas } = render();
    canvas.dispatchEvent(pointerEvent('pointerdown', 10, 10, 1));
    canvas.dispatchEvent(pointerEvent('pointerup', 10, 10, 1));
    fixture.detectChanges();
    expect(fixture.componentInstance.strokes().length).toBe(1);

    fixture.componentInstance.tool.set('eraser');
    canvas.dispatchEvent(pointerEvent('pointerdown', 10, 10, 2));
    canvas.dispatchEvent(pointerEvent('pointerup', 10, 10, 2));
    fixture.detectChanges();

    expect(fixture.componentInstance.strokes().length).toBe(0);
  });

  it('pressing the Clear toolbar action empties the strokes list', () => {
    const { fixture, canvas } = render();
    canvas.dispatchEvent(pointerEvent('pointerdown', 5, 5));
    canvas.dispatchEvent(pointerEvent('pointerup', 5, 5));
    fixture.detectChanges();
    expect(fixture.componentInstance.strokes().length).toBe(1);

    const buttons = fixture.nativeElement.querySelectorAll('.mui-action-button');
    (buttons[2] as HTMLButtonElement).click(); // pen, eraser, [divider], clear
    fixture.detectChanges();

    expect(fixture.componentInstance.strokes().length).toBe(0);
  });

  it('submitting the prompt bar emits the trimmed text and clears the input', () => {
    const { fixture } = render();
    let submitted: string | null = null;
    fixture.componentInstance.promptSubmitted.subscribe((text) => (submitted = text));

    fixture.componentInstance.prompt.set('  make it glow  ');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.mui-button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(submitted).toBe('make it glow');
    expect(fixture.componentInstance.prompt()).toBe('');
  });
});
