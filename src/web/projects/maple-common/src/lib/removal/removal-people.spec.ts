import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync, removal_people_suggestions } from '../raw-pipeline/pkg/raw_wasm';
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
});
