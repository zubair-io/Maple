import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseServerTiming,
  percentile,
  readQueries,
  summaryLines,
  type QueryRun,
} from '../scripts/search-audit.ts';

test('the committed audit set is the 50 production queries', () => {
  const queries = readQueries(
    readFileSync(resolve(import.meta.dir, 'fixtures/search-audit/queries.txt'), 'utf-8'),
  );
  expect(queries.length).toBe(50);
  expect(queries[0]).toBe('group of people standing in front of the ocean');
});

test('percentiles and the summary', () => {
  const run = (ms: number, servedInProcess: boolean, semanticHits: number | null): QueryRun => ({
    query: 'x',
    ms,
    servedInProcess,
    semanticHits,
    phases: {},
  });

  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  expect(summaryLines([run(60, true, 3), run(90, false, null)])).toEqual([
    'median 60 ms  p95 90 ms  max 90 ms',
    'in-process answered 1 / 2; semantic hits on 1 / 2',
  ]);
});

test('server phases are parsed from Server-Timing and summarised', () => {
  expect(
    parseServerTiming('scope;dur=0.4, engine;desc="child";dur=71.2, cache, total;dur=80'),
  ).toEqual({ scope: 0.4, engine: 71.2, total: 80 });
  expect(parseServerTiming(null)).toEqual({});
  expect(parseServerTiming('rows;dur=1..2, total;dur=9')).toEqual({ total: 9 });

  const run = (phases: Record<string, number>): QueryRun => ({
    query: 'x',
    ms: 100,
    servedInProcess: true,
    semanticHits: 0,
    phases,
  });

  expect(
    summaryLines([run({ engine: 70, rows: 5 }), run({ engine: 90, rows: 7 })]).slice(2),
  ).toEqual(['server phases (median ms): engine 70.0  rows 5.0']);
});
