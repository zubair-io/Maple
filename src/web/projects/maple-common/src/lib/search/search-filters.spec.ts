// Pure unit tests for the unified-search filter model (#2865).

import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  activeFilterChips,
  activeFilterCount,
  dateChipLabel,
  filtersToParams,
  presetRange,
  removeChip,
  setCustomRange,
  togglePerson,
  togglePlace,
  togglePreset,
} from './search-filters';

const NOW = new Date('2026-08-15T12:00:00');

describe('search-filters — counting and chips', () => {
  it('counts the date dimension once, people and places each', () => {
    const f = {
      ...EMPTY_FILTERS,
      datePreset: 'last30' as const,
      people: ['Priya Patel', 'Alex Chen'],
      places: ['Portland, OR'],
    };
    expect(activeFilterCount(f)).toBe(4);
    expect(activeFilterChips(f).map((c) => c.kind)).toEqual(['date', 'person', 'person', 'place']);
  });

  it('labels a custom range and counts it as one dimension', () => {
    const f = setCustomRange(EMPTY_FILTERS, '2026-01-01', '2026-02-01');
    expect(activeFilterCount(f)).toBe(1);
    expect(dateChipLabel(f)).toBe('2026-01-01 – 2026-02-01');
  });

  it('removeChip clears exactly the matching dimension/value', () => {
    const f = {
      ...EMPTY_FILTERS,
      datePreset: 'today' as const,
      people: ['Priya Patel'],
      places: ['Kyoto'],
    };
    const noDate = removeChip(f, { kind: 'date', label: 'Today' });
    expect(noDate.datePreset).toBeNull();
    expect(noDate.people).toEqual(['Priya Patel']);
    const noPerson = removeChip(f, { kind: 'person', label: 'Priya Patel' });
    expect(noPerson.people).toEqual([]);
    expect(noPerson.places).toEqual(['Kyoto']);
  });
});

describe('search-filters — toggles and exclusivity', () => {
  it('toggles people and places on/off', () => {
    const on = togglePerson(EMPTY_FILTERS, 'Priya Patel');
    expect(on.people).toEqual(['Priya Patel']);
    expect(togglePerson(on, 'Priya Patel').people).toEqual([]);
    const pl = togglePlace(EMPTY_FILTERS, 'Portland, OR');
    expect(pl.places).toEqual(['Portland, OR']);
  });

  it('preset and custom range are mutually exclusive', () => {
    const preset = togglePreset(setCustomRange(EMPTY_FILTERS, '2026-01-01', null), 'last7');
    expect(preset.datePreset).toBe('last7');
    expect(preset.from).toBeNull();
    const custom = setCustomRange(preset, '2026-03-01', null);
    expect(custom.datePreset).toBeNull();
    expect(custom.from).toBe('2026-03-01');
  });

  it('re-tapping the active preset clears it', () => {
    const on = togglePreset(EMPTY_FILTERS, 'thisYear');
    expect(togglePreset(on, 'thisYear').datePreset).toBeNull();
  });
});

describe('search-filters — wire params', () => {
  it('resolves presets against local time', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-08-15', to: null });
    expect(presetRange('last7', NOW)).toEqual({ from: '2026-08-09', to: null });
    expect(presetRange('last30', NOW)).toEqual({ from: '2026-07-17', to: null });
    expect(presetRange('thisYear', NOW)).toEqual({ from: '2026-01-01', to: null });
  });

  it('maps filters onto from/to + people + place params', () => {
    const f = {
      ...EMPTY_FILTERS,
      datePreset: 'thisYear' as const,
      people: ['Priya Patel'],
      places: ['Portland, OR', 'Kyoto'],
    };
    expect(filtersToParams(f, NOW)).toEqual({
      from: '2026-01-01',
      people: ['Priya Patel'],
      place: ['Portland, OR', 'Kyoto'],
    });
  });

  it('emits nothing for empty filters', () => {
    expect(filtersToParams(EMPTY_FILTERS, NOW)).toEqual({});
  });
});
