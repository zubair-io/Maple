import { describe, it, expect } from 'vitest';

import {
  ALL_TOOLS,
  TOOLS_IN_GROUP,
  defaultDisplayValue,
  displayRange,
  displayValueFromInternal,
  internalValueFromDisplay,
  visibleToolsInGroup,
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
    brightness: [-100, 100],
    temp: [2000, 12000],
    tint: [-150, 150], // ACR's crs:Tint span (#1870)
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
    vignette: [-100, 100], // wired at #1109 (drag bar = vignetteAmount)
    grain: [0, 100], // wired at #1110 (drag bar = grainAmount)
    colorGrade: [-100, 100], // wired at #275 (drag bar = splitToneBalance)
  };

  for (const [tool, range] of Object.entries(expected) as [ToolId, readonly [number, number]][]) {
    it(`${tool} → [${range[0]}, ${range[1]}]`, () => {
      expect(displayRange(tool)).toEqual(range);
    });
  }

  it('returns null for stub tools', () => {
    // hsl / bwMix have no single primary drag-bar field (multi-sub-param
    // panels instead, #1112 / #276); crop is a stub pending its own spec;
    // presets is wired but value-less. No range, so the drag-bar and value
    // chip treat them identically (no phantom track, no misleading
    // midpoint value).
    for (const tool of ['hsl', 'bwMix', 'crop', 'presets'] as const) {
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

  it('range-less tools map to 0, never a misleading midpoint', () => {
    // With no DISPLAY_RANGE entry the mapping is identity, so the chip
    // reads 0 for hsl / bwMix / crop / presets. (The S5 effects all left
    // the gated set: #1109 / #1110 / #1111.)
    for (const tool of ['hsl', 'bwMix', 'crop', 'presets'] as const) {
      expect(displayValueFromInternal(tool, 0)).toBe(0);
      expect(internalValueFromDisplay(tool, 0)).toBe(0);
    }
  });

  it('colorGrade maps its symmetric balance range linearly (#275)', () => {
    expect(displayValueFromInternal('colorGrade', 0)).toBe(0);
    expect(displayValueFromInternal('colorGrade', 100)).toBe(100);
    expect(displayValueFromInternal('colorGrade', -100)).toBe(-100);
    expect(internalValueFromDisplay('colorGrade', -25)).toBe(-25);
  });

  it('grain maps its one-sided 0..100 range affinely (#1110)', () => {
    // The noise/colorNR family: internal -100 → 0, 0 → 50, +100 → 100.
    expect(displayValueFromInternal('grain', -100)).toBe(0);
    expect(displayValueFromInternal('grain', 0)).toBe(50);
    expect(displayValueFromInternal('grain', 100)).toBe(100);
    expect(internalValueFromDisplay('grain', 0)).toBe(-100);
    expect(internalValueFromDisplay('grain', 40)).toBe(-20);
  });

  it('vignette maps its symmetric amount range linearly (#1109)', () => {
    expect(displayValueFromInternal('vignette', 0)).toBe(0);
    expect(displayValueFromInternal('vignette', 100)).toBe(100);
    expect(displayValueFromInternal('vignette', -100)).toBe(-100);
    expect(internalValueFromDisplay('vignette', -50)).toBe(-50);
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

describe('visibleToolsInGroup (#276 — HSL surface hides while Black & White is On)', () => {
  it('returns the full color list, including hsl, when Black & White is Off', () => {
    expect(visibleToolsInGroup('color', false)).toEqual(TOOLS_IN_GROUP.color);
    expect(visibleToolsInGroup('color', false)).toContain('hsl');
    expect(visibleToolsInGroup('color', false)).toContain('bwMix');
  });

  it('drops hsl (but keeps bwMix) from the color list when Black & White is On', () => {
    const visible = visibleToolsInGroup('color', true);
    expect(visible).not.toContain('hsl');
    expect(visible).toContain('bwMix');
    expect(visible).toEqual(TOOLS_IN_GROUP.color.filter((t) => t !== 'hsl'));
  });

  it('is a no-op for every non-color group regardless of Black & White state', () => {
    for (const group of ['light', 'effects', 'detail'] as const) {
      expect(visibleToolsInGroup(group, true)).toEqual(TOOLS_IN_GROUP[group]);
      expect(visibleToolsInGroup(group, false)).toEqual(TOOLS_IN_GROUP[group]);
    }
  });
});
