import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  overlapCount,
  percentile,
  readQueries,
  summaryLines,
  type QueryComparison,
} from '../scripts/search-audit.ts';

test('the committed audit set is the 50 production queries', () => {
  const queries = readQueries(
    readFileSync(resolve(import.meta.dir, 'fixtures/search-audit/queries.txt'), 'utf-8'),
  );
  expect(queries.length).toBe(50);
  expect(queries[0]).toBe('group of people standing in front of the ocean');
});

test('overlap, percentiles and the summary', () => {
  const run = (ms: number, servedInProcess: boolean, semanticHits: number | null) => ({
    ms,
    ids: ['a', 'b', 'c'],
    servedInProcess,
    semanticHits,
  });
  const rows: QueryComparison[] = [
    { query: 'x', inProcess: run(60, true, 3), meilisearch: run(250, false, null), overlap: 2 },
    { query: 'y', inProcess: run(90, false, null), meilisearch: run(270, false, null), overlap: 1 },
  ];

  expect(overlapCount(['a', 'b', 'c'], ['c', 'a', 'z'])).toBe(2);
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  expect(summaryLines(rows, 30)).toEqual([
    'in-process   median 60 ms  p95 90 ms  max 90 ms',
    'meilisearch  median 250 ms  p95 270 ms  max 270 ms',
    'mean top-30 overlap 1.5 / 30',
    'in-process answered 1 / 2; semantic hits on 1 / 2',
  ]);
});
