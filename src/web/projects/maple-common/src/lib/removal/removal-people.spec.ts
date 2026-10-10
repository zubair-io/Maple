import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  initSync,
  removal_people_suggestions,
  removal_selection,
} from '../raw-pipeline/pkg/raw_wasm';
import { suggestPeopleWithMasks } from './removal-person-proposals';
import {
  REMOVAL_PERSON_ROLES,
  type RemovalPersonSuggestion,
} from '../generated/removal-models.generated';

beforeAll(() => {
  initSync({
    module: readFileSync(
      resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
    ),
  });
});
const suggest = (detections: unknown[]): RemovalPersonSuggestion[] =>
  JSON.parse(
    removal_people_suggestions(
      JSON.stringify({ schema: 1, source_width: 1000, source_height: 1000, detections }),
    ),
  );
const person = (bounds: number[], score: number) => ({ class: 0, bounds, score });
const mask = (x: number) =>
  removal_selection(
    1000,
    1000,
    JSON.stringify({
      schema: 1,
      strokes: [{ points: [[x, 0.45]], radius: 0.001, subtract: false }],
    }),
  );

describe('actual WASM shared person proposals', () => {
  it('keeps subjects and uncertain instances while selecting separated smaller people', () => {
    const p = suggest([
      person([0, 0, 300, 900], 0.98),
      person([600, 200, 650, 400], 0.92),
      person([800, 200, 850, 400], 0.6),
    ]);
    expect(p.map((p) => p.role)).toEqual(['subject', 'background', 'uncertain']);
    expect(p.map((p) => p.keep)).toEqual([true, false, true]);
    expect(p.map((p) => REMOVAL_PERSON_ROLES[p.role])).toEqual([
      'Likely subject',
      'Suggested background',
      'Uncertain',
    ]);
  });
  it('collapses duplicate proposals and keeps overlapping uncertain people', () => {
    const p = suggest([
      person([0, 0, 300, 900], 0.98),
      person([1, 1, 301, 901], 0.97),
      person([250, 400, 350, 600], 0.92),
    ]);
    expect(p).toHaveLength(2);
    expect(p.map((p) => p.keep)).toEqual([true, true]);
    expect(p.map((p) => p.role)).toEqual(['subject', 'uncertain']);
  });
  it('distinguishes no detections from invalid detector output', () => {
    expect(suggest([])).toEqual([]);
    expect(() => suggest([person([0, 0, 20], 0.9)])).toThrow();
    expect(() => suggest([person([0, 0, 20, 20], 1.1)])).toThrow();
  });
  it('uses actual masks to free a background proposal from intersecting boxes', () => {
    const proposed = suggest([person([0, 0, 300, 900], 0.98), person([250, 400, 300, 550], 0.92)]);
    expect(proposed.map((p) => p.keep)).toEqual([true, true]);
    const masks = [mask(0.02), mask(0.27)];
    const reviewed = suggestPeopleWithMasks(proposed, masks, 1000, 1000);
    expect(reviewed.map((p) => p.role)).toEqual(['subject', 'background']);
    expect(reviewed.map((p) => p.keep)).toEqual([true, false]);
    expect(proposed.map((p) => p.keep)).toEqual([true, true]);
  });
  it('keeps true mask overlap and missing subject masks conservative', () => {
    const proposed = suggest([person([0, 0, 300, 900], 0.98), person([250, 400, 300, 550], 0.92)]);
    const actual = mask(0.27);
    const overlap = suggestPeopleWithMasks(proposed, [actual, actual], 1000, 1000);
    expect(overlap.map((p) => p.role)).toEqual(['subject', 'uncertain']);
    expect(overlap.map((p) => p.keep)).toEqual([true, true]);
    const missing = suggestPeopleWithMasks(proposed, [new Uint8Array(), actual], 1000, 1000);
    expect(missing.map((p) => p.keep)).toEqual([true, true]);
  });
  it('refuses mismatched mask counts and source geometry', () => {
    const proposed = suggest([person([0, 0, 300, 900], 0.98)]);
    expect(() => suggestPeopleWithMasks(proposed, [], 1000, 1000)).toThrow();
    expect(() => suggestPeopleWithMasks(proposed, [mask(0.02)], 1001, 1000)).toThrow();
  });
});
