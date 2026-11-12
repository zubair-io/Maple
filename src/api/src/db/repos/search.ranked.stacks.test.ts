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

function row(
  r: number,
  id: string,
  stackPrimaryId: string | null = null,
  shot: Pick<WindowRow, 'captured_at' | 'filename'> = { captured_at: null, filename: null },
): WindowRow {
  return {
    r,
    id,
    maple_id: id,
    owner_id: null,
    stack_primary_id: stackPrimaryId,
    media_kind: 'image',
    ...shot,
  };
}

/** The JPEG ranks first and its RAW 401st, past the 400-deep step that serves pages 0-2. */
const RANKING: WindowRow[] = Array.from({ length: 2000 }, (_, index) => {
  if (index === 0) return row(index, 'jpeg', 'raw');
  if (index === 400) return row(index, 'raw');
  return row(index, `hit-${index}`);
});

/**
 * As {@link RANKING}, but the JPEG has a copy ranked second in its capture second (#4557), and
 * the RAW was stamped a second earlier, so the RAW alone is a different shot from the copy.
 */
const WITH_COPY: WindowRow[] = RANKING.map((entry) => {
  if (entry.id === 'jpeg') {
    return row(0, 'jpeg', 'raw', {
      captured_at: '2024-06-01T10:00:01.000Z',
      filename: 'IMG_1.JPG',
    });
  }
  if (entry.id === 'raw') {
    return row(400, 'raw', null, {
      captured_at: '2024-06-01T10:00:00.000Z',
      filename: 'IMG_1.CR3',
    });
  }
  if (entry.r === 1) {
    return row(1, 'copy', null, {
      captured_at: '2024-06-01T10:00:01.000Z',
      filename: 'IMG_1(2).JPG',
    });
  }
  return entry;
});

const rankerOf =
  (ranking: readonly WindowRow[]): WindowRanker =>
  async (depth, lookahead = 0) =>
    foldRankedStacks(FOLDING, {
      rows: ranking.slice(0, depth),
      beyond: ranking.slice(depth, depth + lookahead),
      considered: Math.min(ranking.length, depth + lookahead),
    });

const ids = (rows: readonly WindowRow[]) => rows.map((entry) => entry.id);

/** The window a request reaching `need` rows is served from; this ranker always answers. */
async function windowRows(ranking: readonly WindowRow[], need: number, depth: number) {
  const window = await rankWindow(rankerOf(ranking), need);
  expect(window).not.toBeNull();
  expect(window!.depth).toBe(depth);
  return ids(window!.rows);
}

describe('ranked RAW+JPEG fold #5849', () => {
  it('a widened window serves the stack at its best rank, so no served page loses a row', async () => {
    const narrow = await windowRows(RANKING, 300, 400);
    const wide = await windowRows(RANKING, 400, 1600);

    // Pages 0-2 at limit=100 come from the narrow window, page 3 from the wide one.
    const served = [...narrow.slice(0, 300), ...wide.slice(300, 400)];
    expect(served).toEqual(['jpeg', ...ids(RANKING.slice(1, 400))]);
    expect(wide[0]).toBe('raw');
    expect(wide).not.toContain('jpeg');
    expect(wide.filter((id) => id === 'raw')).toHaveLength(1);
  });

  it('the stack keeps the shot of the half that ranked first, so its copies stay collapsed', async () => {
    const narrow = await windowRows(WITH_COPY, 300, 400);
    const wide = await windowRows(WITH_COPY, 400, 1600);

    expect(narrow).not.toContain('copy');
    expect(wide).not.toContain('copy');
    const served = [...narrow.slice(0, 300), ...wide.slice(300, 400)];
    // Hits 2-399, then the RAW's own rank folds away and hit 401 follows.
    expect(served).toEqual(['jpeg', ...ids(WITH_COPY.slice(2, 402)).filter((id) => id !== 'raw')]);
  });

  it('the stack leader remembers the JPEG that folded into it, whichever half ranked first', () => {
    for (const rows of [
      [row(1, 'jpeg', 'raw'), row(2, 'lone'), row(3, 'raw')],
      [row(3, 'raw'), row(2, 'lone'), row(1, 'jpeg', 'raw')],
    ]) {
      const folded = foldRankedStacks(FOLDING, { rows, considered: rows.length }).rows;
      expect(ids(folded)).toEqual(['raw', 'lone']);
      expect(folded[0]?.stack_companion).toEqual({ r: 1, id: 'jpeg' });
    }
  });

  it('a JPEG whose RAW did not rank stays a result of its own', () => {
    const rows = [row(1, 'jpeg', 'raw'), row(2, 'lone')];
    const folded = foldRankedStacks(FOLDING, { rows, considered: rows.length }).rows;
    expect(ids(folded)).toEqual(['jpeg', 'lone']);
    expect(folded[0]?.stack_companion).toBeUndefined();
  });
});
