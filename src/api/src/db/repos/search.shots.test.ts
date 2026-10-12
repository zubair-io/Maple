/**
 * The shot rule (#4557): which search results are copies of one photograph. Every example is a
 * pair seen on production; the burst neighbours are the ones that must survive.
 */

import { describe, expect, test } from 'bun:test';
import { collapseShots, shotKey, shotStem, type ShotFields } from './search.shots.ts';

const SECOND = '2018-07-07T13:30:40.000Z';

function sameShot(a: string, b: string, capturedAt: string | null = SECOND): boolean {
  const left = shotKey({ captured_at: capturedAt, filename: a });
  return left !== null && left === shotKey({ captured_at: capturedAt, filename: b });
}

describe('copies of one shot', () => {
  for (const [a, b] of [
    ['IMG_0039.CR2', 'IMG_0039.JPG'],
    ['_MG_4066.JPG', '_MG_4066(2).jpg'],
    ['_MG_4006.CR2', '_MG_4006(2).jpg'],
    ['_MG_4006.CR2', '_MG_4006(1)(1).jpg'],
    ['_MG_4006(2).jpg', '_MG_4006(1)(1).jpg'],
    ['_MG_5652.CR2', '_MG_5652-ultra-8.jpg'],
    ['20170521_175035.mp4', '20170521_175035(1).mp4'],
    ['IMG_1234 (1).HEIC', 'img_1234.heic'],
    ['IMG_1234-Edit(1).jpg', 'IMG_1234.CR3'],
  ]) {
    test(`${a} and ${b} are one shot`, () => {
      expect(sameShot(a!, b!)).toBe(true);
    });
  }
});

describe('different shots', () => {
  for (const [a, b] of [
    ['_MG_1768.CR2', '_MG_1770.CR2'],
    ['IMG_3816.HEIC', 'IMG_3817.HEIC'],
    ['20180707_133040_093.jpg', '20180707_133040_095.jpg'],
    ['2017-05-21 17.50.35.jpg', '2017-05-21 17.50.36.jpg'],
    ['2017-05-21 17.50.35.jpg', '2017-05-21 17.50.35-1.jpg'],
  ]) {
    test(`${a} and ${b} stay apart`, () => {
      expect(sameShot(a!, b!)).toBe(false);
    });
  }

  test('the same name at a different capture time is a different shot', () => {
    expect(
      shotKey({ captured_at: SECOND, filename: 'IMG_0039.CR2' }) ===
        shotKey({ captured_at: '2006-01-01T00:00:00.000Z', filename: 'IMG_0039.JPG' }),
    ).toBe(false);
  });

  test('a row without a capture time or a filename is never collapsed', () => {
    expect(sameShot('IMG_0039.CR2', 'IMG_0039.JPG', null)).toBe(false);
    expect(shotKey({ captured_at: SECOND, filename: null })).toBeNull();
  });
});

describe('shotStem', () => {
  test('drops the extension, copy markers and an export suffix, and folds case', () => {
    expect(shotStem('_MG_4006(1)(1).jpg')).toBe('_mg_4006');
    expect(shotStem('_MG_5652-ultra-8.jpg')).toBe('_mg_5652');
    expect(shotStem('IMG_0039.CR2')).toBe('img_0039');
    expect(shotStem('archive.tar.gz')).toBe('archive.tar');
    expect(shotStem('.hidden')).toBe('.hidden');
    expect(shotStem('-edit.jpg')).toBe('-edit');
  });
});

describe('collapseShots', () => {
  const row = (id: string, filename: string | null, captured_at: string | null = SECOND) =>
    ({ id, filename, captured_at }) satisfies ShotFields & { id: string };

  test('keeps the best-ranked copy of each shot, in rank order', () => {
    const rows = [
      row('jpg', '_MG_4006(2).jpg'),
      row('burst', '_MG_1768.CR2'),
      row('raw', '_MG_4006.CR2'),
      row('undated-a', 'x.jpg', null),
      row('undated-b', 'x.cr2', null),
      row('copy', '_MG_4006(1)(1).jpg'),
      row('neighbour', '_MG_1770.CR2'),
    ];
    expect(collapseShots(rows).map((kept) => kept.id)).toEqual([
      'jpg',
      'burst',
      'undated-a',
      'undated-b',
      'neighbour',
    ]);
  });

  test('a deeper window collapses to the shallower window followed by new shots', () => {
    const deep = [
      row('a', 'A.CR2'),
      row('b', 'A.JPG'),
      row('c', 'C.CR2'),
      row('d', 'D.CR2'),
      row('e', 'C(1).jpg'),
    ];
    const shallow = collapseShots(deep.slice(0, 3)).map((kept) => kept.id);
    const deeper = collapseShots(deep).map((kept) => kept.id);
    expect(deeper.slice(0, shallow.length)).toEqual(shallow);
  });
});
