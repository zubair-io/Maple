import { describe, test, expect } from 'bun:test';
import { restructureDir, OLD_LAYOUT_DIR_RE } from './restructure-path.ts';

describe('restructureDir', () => {
  test('with-location old layout → drops the MM-DD day folder', () => {
    expect(restructureDir('2024/Tokyo/03-15')).toBe('2024/Tokyo');
    expect(restructureDir('2024/St. Tropez _ Var/12-31')).toBe('2024/St. Tropez _ Var');
  });

  test('no-location old layout → drops the DD day folder, keeps month', () => {
    expect(restructureDir('2024/03/15')).toBe('2024/03');
    expect(restructureDir('1999/12/01')).toBe('1999/12');
  });

  test('idempotent: new-layout (2-segment) paths are left untouched', () => {
    expect(restructureDir('2024/Tokyo')).toBeNull();
    expect(restructureDir('2024/03')).toBeNull();
  });

  test('date-named location is NOT re-collapsed (the idempotency trap)', () => {
    // A migrated photo whose location is literally "12-25" lives at
    // 2024/12-25 — 2 segments → already new → must be left alone.
    expect(restructureDir('2024/12-25')).toBeNull();
  });

  test('library root and unrelated dirs are left untouched', () => {
    expect(restructureDir('')).toBeNull();
    expect(restructureDir('vacation')).toBeNull();
    expect(restructureDir('vacation/2024/photos')).toBeNull(); // seg0 not a year
    expect(restructureDir('2024/Tokyo/Shinjuku/03-15')).toBeNull(); // 4 segments
  });

  test('3-segment dir that is not a recognized date-folder is skipped', () => {
    // year + two non-date segments → not ours.
    expect(restructureDir('2024/Tokyo/Shinjuku')).toBeNull();
  });

  test('OLD_LAYOUT_DIR_RE pre-filter agrees with restructureDir on accept/reject', () => {
    const accept = ['2024/Tokyo/03-15', '2024/03/15', '2024/A_B/01-01'];
    const reject = ['2024/Tokyo', '2024/03', '2024/12-25', '', 'vacation/2024/x'];
    for (const d of accept) {
      expect(OLD_LAYOUT_DIR_RE.test(d)).toBe(true);
      expect(restructureDir(d)).not.toBeNull();
    }
    for (const d of reject) {
      // The regex may admit a few that restructureDir then rejects, but it must
      // never reject one restructureDir accepts.
      if (restructureDir(d) !== null) expect(OLD_LAYOUT_DIR_RE.test(d)).toBe(true);
    }
  });
});
