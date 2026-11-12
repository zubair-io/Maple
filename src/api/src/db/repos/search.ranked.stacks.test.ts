/**
 * A ranked window folds a RAW+JPEG stack at the stack's best rank (#5849), so a wider window on
 * the ladder keeps every prefix a narrower one served: the pages a request already read never
 * lose a row when a deeper page admits the stack's other half.
 */

import { describe, expect, it } from 'bun:test';
import {
  foldRankedStacks,
  rankWindow,
  type WindowRanker,
  type WindowRow,
} from './search.ranked.ts';
import type { SearchWhere } from './search.where.ts';

const FOLDING = { foldStacks: true } as SearchWhere;

function row(r: number, id: string, stackPrimaryId: string | null = null): WindowRow {
  return {
    r,
    id,
    maple_id: id,
    owner_id: null,
    stack_primary_id: stackPrimaryId,
    captured_at: null,
    media_kind: 'image',
    filename: null,
  };
}

/** The JPEG ranks first and its RAW 401st, past the 400-deep step that serves pages 0-2. */
const RANKING: WindowRow[] = Array.from({ length: 2000 }, (_, index) => {
  if (index === 0) return row(index, 'jpeg', 'raw');
  if (index === 400) return row(index, 'raw');
  return row(index, `hit-${index}`);
});

const ranker: WindowRanker = async (depth, lookahead = 0) =>
  foldRankedStacks(FOLDING, {
    rows: RANKING.slice(0, depth),
    beyond: RANKING.slice(depth, depth + lookahead),
    considered: Math.min(RANKING.length, depth + lookahead),
  });

const ids = (rows: readonly WindowRow[]) => rows.map((entry) => entry.id);

/** The window a request reaching `need` rows is served from; this ranker always answers. */
async function windowRows(need: number, depth: number): Promise<string[]> {
  const window = await rankWindow(ranker, need);
  expect(window).not.toBeNull();
  expect(window!.depth).toBe(depth);
  return ids(window!.rows);
}

describe('ranked RAW+JPEG fold #5849', () => {
  it('a widened window serves the stack at its best rank, so no served page loses a row', async () => {
    const narrow = await windowRows(300, 400);
    const wide = await windowRows(400, 1600);

    // Pages 0-2 at limit=100 come from the narrow window, page 3 from the wide one.
    const served = [...narrow.slice(0, 300), ...wide.slice(300, 400)];
    expect(served).toEqual(['jpeg', ...ids(RANKING.slice(1, 400))]);
    expect(wide[0]).toBe('raw');
    expect(wide).not.toContain('jpeg');
    expect(wide.filter((id) => id === 'raw')).toHaveLength(1);
  });

  it('the stack leader remembers the JPEG that folded into it, whichever half ranked first', () => {
    for (const rows of [
      [row(1, 'jpeg', 'raw'), row(2, 'lone'), row(3, 'raw')],
      [row(3, 'raw'), row(2, 'lone'), row(1, 'jpeg', 'raw')],
    ]) {
      const folded = foldRankedStacks(FOLDING, { rows, considered: rows.length }).rows;
      expect(ids(folded)).toEqual(['raw', 'lone']);
      expect(folded[0]?.stack_companion_r).toBe(1);
    }
  });

  it('a JPEG whose RAW did not rank stays a result of its own', () => {
    const rows = [row(1, 'jpeg', 'raw'), row(2, 'lone')];
    const folded = foldRankedStacks(FOLDING, { rows, considered: rows.length }).rows;
    expect(ids(folded)).toEqual(['jpeg', 'lone']);
    expect(folded[0]?.stack_companion_r).toBeUndefined();
  });
});
