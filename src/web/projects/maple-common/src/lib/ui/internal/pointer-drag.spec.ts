import { describe, expect, it } from 'vitest';
import {
  arrowKeyDelta,
  formatSignedValue,
  isPointerDragEnd,
  isPointerDragMove,
  percentInRange,
} from './pointer-drag';

function pointerEvent(pointerId: number): PointerEvent {
  return { pointerId } as PointerEvent;
}

describe('isPointerDragMove', () => {
  it('is true only while dragging and the pointer matches', () => {
    expect(isPointerDragMove(true, pointerEvent(1), 1)).toBe(true);
    expect(isPointerDragMove(false, pointerEvent(1), 1)).toBe(false);
    expect(isPointerDragMove(true, pointerEvent(2), 1)).toBe(false);
    expect(isPointerDragMove(true, pointerEvent(1), null)).toBe(false);
  });
});

describe('isPointerDragEnd', () => {
  it('is true only when the ending pointer matches the tracked one', () => {
    expect(isPointerDragEnd(pointerEvent(1), 1)).toBe(true);
    expect(isPointerDragEnd(pointerEvent(2), 1)).toBe(false);
    expect(isPointerDragEnd(pointerEvent(1), null)).toBe(false);
  });
});

describe('arrowKeyDelta', () => {
  it('maps arrow keys to a signed step delta', () => {
    expect(arrowKeyDelta('ArrowLeft', 5)).toBe(-5);
    expect(arrowKeyDelta('ArrowDown', 5)).toBe(-5);
    expect(arrowKeyDelta('ArrowRight', 5)).toBe(5);
    expect(arrowKeyDelta('ArrowUp', 5)).toBe(5);
  });

  it('returns null for any other key', () => {
    expect(arrowKeyDelta('Enter', 5)).toBeNull();
  });
});

describe('percentInRange', () => {
  it('scales a value within [min, max] to [0, 100]', () => {
    expect(percentInRange(5, 0, 10, 50)).toBe(50);
    expect(percentInRange(0, 0, 10, 50)).toBe(0);
    expect(percentInRange(10, 0, 10, 50)).toBe(100);
  });

  it('uses the fallback when min === max', () => {
    expect(percentInRange(5, 5, 5, 50)).toBe(50);
    expect(percentInRange(5, 5, 5, 0)).toBe(0);
  });
});

describe('formatSignedValue', () => {
  it('adds an explicit + sign for positive values, none for zero/negative', () => {
    expect(formatSignedValue(5, 1, '')).toBe('+5');
    expect(formatSignedValue(0, 1, '')).toBe('0');
    expect(formatSignedValue(-5, 1, '')).toBe('-5');
  });

  it('scales decimal precision with the step size', () => {
    expect(formatSignedValue(1.234, 1, '')).toBe('+1');
    expect(formatSignedValue(1.234, 0.5, '')).toBe('+1.2');
    expect(formatSignedValue(1.234, 0.05, '')).toBe('+1.23');
  });

  it('appends a unit suffix when given', () => {
    expect(formatSignedValue(5, 1, 'px')).toBe('+5 px');
  });
});
