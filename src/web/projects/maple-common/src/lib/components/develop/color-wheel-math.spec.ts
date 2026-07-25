// color-wheel-math.spec.ts — the colour-grading wheels' polar math (#275).

import { describe, expect, it } from 'vitest';
import { nudgeWheel, posToWheel, wheelToPos, wrapHue } from './color-wheel-math';

describe('wrapHue', () => {
  it('wraps into [0, 360)', () => {
    expect(wrapHue(0)).toBe(0);
    expect(wrapHue(360)).toBe(0);
    expect(wrapHue(-30)).toBe(330);
    expect(wrapHue(400)).toBe(40);
  });
});

describe('posToWheel / wheelToPos', () => {
  it('round-trips hue and saturation across the wheel', () => {
    for (const hue of [0, 30, 90, 150, 210, 270, 330]) {
      for (const saturation of [0, 25, 60, 100]) {
        const back = posToWheel(wheelToPos({ hue, saturation }));
        expect(back.saturation).toBe(saturation);
        // Hue is undefined at the centre — saturation 0 pins it to 0.
        if (saturation > 0) expect(back.hue).toBe(hue);
      }
    }
  });

  it('puts the centre at saturation 0', () => {
    expect(posToWheel({ x: 0.5, y: 0.5 })).toEqual({ hue: 0, saturation: 0 });
  });

  it('puts hue 0 at the right rim and 90 at the top rim', () => {
    expect(wheelToPos({ hue: 0, saturation: 100 })).toEqual({ x: 1, y: 0.5 });
    const top = wheelToPos({ hue: 90, saturation: 100 });
    expect(top.x).toBeCloseTo(0.5, 6);
    expect(top.y).toBeCloseTo(1, 6);
  });

  it('clamps a drag past the rim to saturation 100, keeping the angle', () => {
    // The box corner is at radius √2 — well outside the unit disc.
    const corner = posToWheel({ x: 1, y: 1 });
    expect(corner.saturation).toBe(100);
    expect(corner.hue).toBe(45);
  });

  it('clamps an out-of-range model saturation onto the wheel', () => {
    expect(wheelToPos({ hue: 0, saturation: 500 })).toEqual({ x: 1, y: 0.5 });
    expect(wheelToPos({ hue: 0, saturation: -20 })).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('nudgeWheel', () => {
  const start = { hue: 10, saturation: 50 };

  it('rotates hue on left/right and wraps past zero', () => {
    expect(nudgeWheel(start, 'ArrowRight')).toEqual({ hue: 11, saturation: 50 });
    expect(nudgeWheel({ hue: 0, saturation: 50 }, 'ArrowLeft')).toEqual({
      hue: 359,
      saturation: 50,
    });
  });

  it('grows and shrinks saturation on up/down, clamped to [0, 100]', () => {
    expect(nudgeWheel(start, 'ArrowUp')).toEqual({ hue: 10, saturation: 51 });
    expect(nudgeWheel({ hue: 10, saturation: 100 }, 'ArrowUp')?.saturation).toBe(100);
    expect(nudgeWheel({ hue: 10, saturation: 0 }, 'ArrowDown')?.saturation).toBe(0);
  });

  it('ignores every other key', () => {
    expect(nudgeWheel(start, 'Enter')).toBeNull();
    expect(nudgeWheel(start, 'a')).toBeNull();
  });
});
