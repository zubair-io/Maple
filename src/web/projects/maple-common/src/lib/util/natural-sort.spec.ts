import { describe, it, expect } from 'vitest';

import { naturalCompare } from './natural-sort';

describe('naturalCompare', () => {
  it('orders embedded digit runs numerically, not lexicographically', () => {
    const names = ['Trip 10', 'Trip 2', 'Trip 1'];
    expect([...names].sort(naturalCompare)).toEqual(['Trip 1', 'Trip 2', 'Trip 10']);
  });

  it('matches plain localeCompare ordering for names with no digits', () => {
    const names = ['Banff', 'Alps', 'Coastline'];
    expect([...names].sort(naturalCompare)).toEqual(['Alps', 'Banff', 'Coastline']);
  });

  it('is case-insensitive (sensitivity: base)', () => {
    const names = ['banff', 'Alps', 'coastline'];
    expect([...names].sort(naturalCompare)).toEqual(['Alps', 'banff', 'coastline']);
  });

  it('handles multi-digit runs at different positions consistently', () => {
    const names = ['IMG_100', 'IMG_20', 'IMG_3'];
    expect([...names].sort(naturalCompare)).toEqual(['IMG_3', 'IMG_20', 'IMG_100']);
  });

  it('treats names differing only in case as equal', () => {
    expect(naturalCompare('Trip', 'trip')).toBe(0);
  });

  it('treats names differing only in accent/diacritics as equal (sensitivity: base)', () => {
    expect(naturalCompare('café', 'cafe')).toBe(0);
  });
});
