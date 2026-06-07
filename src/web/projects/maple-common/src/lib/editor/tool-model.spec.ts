import { describe, it, expect } from 'vitest';

import {
  ALL_TOOLS,
  defaultDisplayValue,
  displayRange,
  displayValueFromInternal,
  internalValueFromDisplay,
  type ToolId,
} from './tool-model';

// These assertions pin the display ranges + defaults to the exact values
// that were hand-maintained before #953 sourced them from the generated
// `ADJUSTMENT_RANGES` / `defaultGeneratedAdjustmentModel` tables. If the
// canonical raw-core schema changes a bound or default, this fails loudly
// rather than letting the editor silently drift from the pipeline.

describe('displayRange (sourced from generated ADJUSTMENT_RANGES)', () => {
  const expected: Partial<Record<ToolId, readonly [number, number]>> = {
    exposure: [-4, 4],
    temp: [2000, 12000],
    tint: [-100, 100],
    contrast: [-100, 100],
    highlights: [-100, 100],
    shadows: [-100, 100],
    whites: [-100, 100],
    blacks: [-100, 100],
    vibrance: [-100, 100],
    saturation: [-100, 100],
    clarity: [-100, 100],
    texture: [-100, 100],
    dehaze: [-100, 100],
    sharpen: [0, 150],
    noise: [0, 100],
    colorNR: [0, 100],
    // vignette / grain / splitTone are intentionally absent — re-gated to
    // stubs at #952, so they have no display range (asserted null below).
  };

  for (const [tool, range] of Object.entries(expected) as [ToolId, readonly [number, number]][]) {
    it(`${tool} → [${range[0]}, ${range[1]}]`, () => {
      expect(displayRange(tool)).toEqual(range);
    });
  }

  it('returns null for stub tools', () => {
    // The three #952-gated effects join hsl / crop / presets: no range, so
    // the drag-bar and value chip treat them identically (no phantom track,
    // no misleading midpoint value).
    for (const tool of ['hsl', 'crop', 'presets', 'vignette', 'grain', 'splitTone'] as const) {
      expect(displayRange(tool)).toBeNull();
    }
  });
});

describe('defaultDisplayValue (sourced from generated defaults)', () => {
  it('temp = 6500, sharpen = 40, colorNR = 25', () => {
    expect(defaultDisplayValue('temp')).toBe(6500);
    expect(defaultDisplayValue('sharpen')).toBe(40);
    expect(defaultDisplayValue('colorNR')).toBe(25);
  });

  it('every other tool defaults to 0', () => {
    for (const tool of ALL_TOOLS) {
      if (tool === 'temp' || tool === 'sharpen' || tool === 'colorNR') continue;
      expect(defaultDisplayValue(tool)).toBe(0);
    }
  });
});

describe('value mapping (internal -100..100 ↔ display)', () => {
  it('temp pivots on its 6500 default', () => {
    expect(displayValueFromInternal('temp', 0)).toBe(6500);
    expect(displayValueFromInternal('temp', 100)).toBe(12000);
    expect(displayValueFromInternal('temp', -100)).toBe(2000);
    expect(internalValueFromDisplay('temp', 6500)).toBe(0);
    expect(internalValueFromDisplay('temp', 12000)).toBe(100);
    expect(internalValueFromDisplay('temp', 2000)).toBe(-100);
  });

  it('sharpen pivots on its 40 default', () => {
    expect(displayValueFromInternal('sharpen', 0)).toBe(40);
    expect(displayValueFromInternal('sharpen', 100)).toBe(150);
    expect(internalValueFromDisplay('sharpen', 40)).toBe(0);
    expect(internalValueFromDisplay('sharpen', 150)).toBe(100);
  });

  it('0..100 tools (colorNR) map affinely onto -100..100', () => {
    expect(displayValueFromInternal('colorNR', -100)).toBe(0);
    expect(displayValueFromInternal('colorNR', 0)).toBe(50);
    expect(displayValueFromInternal('colorNR', 100)).toBe(100);
    expect(internalValueFromDisplay('colorNR', 25)).toBe(-50);
  });

  it('gated stub tools map to 0, never a misleading midpoint (#952)', () => {
    // Regression for the Grain "50" chip: a 0..100 tool would otherwise map
    // internal 0 → display 50 (see colorNR above). With no DISPLAY_RANGE
    // entry the mapping is identity, so an unset stub reads 0 — matching
    // hsl / crop / presets. Asserted for all three #952-gated effects.
    for (const tool of ['vignette', 'grain', 'splitTone'] as const) {
      expect(displayValueFromInternal(tool, 0)).toBe(0);
      expect(internalValueFromDisplay(tool, 0)).toBe(0);
    }
  });

  it('exposure maps linearly across ±4 EV', () => {
    expect(displayValueFromInternal('exposure', 100)).toBe(4);
    expect(displayValueFromInternal('exposure', -100)).toBe(-4);
    expect(internalValueFromDisplay('exposure', 4)).toBe(100);
  });

  it('round-trips internal → display → internal for representative tools', () => {
    const tools: ToolId[] = ['temp', 'sharpen', 'colorNR', 'exposure', 'tint', 'contrast'];
    for (const tool of tools) {
      for (const v of [-100, -50, 0, 50, 100]) {
        const d = displayValueFromInternal(tool, v);
        expect(internalValueFromDisplay(tool, d)).toBeCloseTo(v, 6);
      }
    }
  });
});
