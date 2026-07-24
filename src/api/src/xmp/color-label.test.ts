import { describe, it, expect } from 'bun:test';
import { COLOR_LABELS, VALID_COLOR_LABELS } from './color-label.ts';

describe('color-label vocabulary (#1657)', () => {
  it('is the canonical six-color set', () => {
    expect(COLOR_LABELS).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);
  });

  it('VALID_COLOR_LABELS has one entry per COLOR_LABELS member', () => {
    expect(VALID_COLOR_LABELS.size).toBe(COLOR_LABELS.length);
    for (const c of COLOR_LABELS) expect(VALID_COLOR_LABELS.has(c)).toBe(true);
  });

  it('accepts every canonical color, including orange and purple', () => {
    for (const c of COLOR_LABELS) expect(VALID_COLOR_LABELS.has(c)).toBe(true);
  });

  it('rejects anything outside the vocabulary (case-sensitive, no empty string)', () => {
    for (const bad of ['magenta', 'Red', '', 'RED']) {
      expect(VALID_COLOR_LABELS.has(bad)).toBe(false);
    }
  });
});
