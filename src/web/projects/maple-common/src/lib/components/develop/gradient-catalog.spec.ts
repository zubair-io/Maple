// gradient-catalog.spec.ts — completeness gate: every wired ToolId must
// have an explicit entry in the gradient catalog. This fires loud if a new
// ToolId is added to tool-model without a matching gradient.

import { describe, it, expect } from 'vitest';
import { ALL_TOOLS } from '../../editor/tool-model';
import { allGradientToolIds, gradientFor } from './gradient-catalog';

describe('gradient-catalog completeness', () => {
  it('covers every ToolId in ALL_TOOLS', () => {
    const catalogIds = new Set(allGradientToolIds());
    const missing = ALL_TOOLS.filter((id) => !catalogIds.has(id));
    expect(missing).toEqual([]);
  });

  it('returns a valid CSS gradient for every ToolId', () => {
    for (const toolId of ALL_TOOLS) {
      const grad = gradientFor(toolId);
      expect(typeof grad).toBe('string');
      expect(grad).toContain('linear-gradient');
    }
  });

  it('returns sub-param override when provided', () => {
    const primary = gradientFor('vignette');
    const override = gradientFor('vignette', 'feather');
    // The override for vignette/feather exists and differs from the base gradient
    // (feather is light→muted; base is dark→mid→dark vignette shape)
    expect(typeof override).toBe('string');
    expect(override).toContain('linear-gradient');
    // feather override is one-directional, primary is symmetric — they differ
    expect(override).not.toBe(primary);
  });

  it('falls back to tool gradient for unknown sub-param ids', () => {
    const primary = gradientFor('exposure');
    const fallback = gradientFor('exposure', 'nonexistent-sub-param');
    expect(fallback).toBe(primary);
  });
});
