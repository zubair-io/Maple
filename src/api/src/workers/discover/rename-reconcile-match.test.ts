/**
 * Pure unit tests for `matchExternalRenameFingerprints` (#2934) — no Mongo,
 * no filesystem, no EXIF decode. Mirrors Apple's `ExternalRenameMatcherTests`
 * and Windows' `RenameReconciliationLogicTests`: hand-built fingerprint
 * records in, matched pairs out. The end-to-end sweep-integration coverage
 * (real files, real EXIF, real Mongo) lives in `rename-reconcile.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import {
  matchExternalRenameFingerprints,
  type ExternalRenameCandidate,
} from './rename-reconcile.ts';

function candidate(
  filename: string,
  size: number,
  dateTimeOriginal: string | null,
  cameraSerial: string | null = null,
): ExternalRenameCandidate {
  return { filename, fingerprint: { size, dateTimeOriginal, cameraSerial } };
}

describe('matchExternalRenameFingerprints', () => {
  it('two photos sharing only a size never merge', () => {
    const missing = [candidate('IMG_1.CR3', 5_000_000, '2024-06-15T10:30:00', 'SN1')];
    const fresh = [candidate('IMG_2.CR3', 5_000_000, '2024-07-20T14:00:00', 'SN1')];
    expect(matchExternalRenameFingerprints(missing, fresh)).toEqual([]);
  });

  it('date present on one side only declines — the dateless side never fingerprints', () => {
    const missing = [candidate('IMG_3.CR3', 4_200_000, '2024-06-15T10:30:00', 'SN2')];
    const fresh = [candidate('IMG_4.CR3', 4_200_000, null, 'SN2')];
    expect(matchExternalRenameFingerprints(missing, fresh)).toEqual([]);
  });

  it('an unreadable date excludes the candidate entirely, not just from this one match', () => {
    // The missing side's own date is unreadable — it must never enter the
    // fingerprint pool at all, even though everything else about it (size,
    // serial) looks like a plausible match for the new candidate.
    const missing = [candidate('IMG_5.CR3', 3_000_000, null, 'SN3')];
    const fresh = [candidate('IMG_6.CR3', 3_000_000, '2024-01-01T00:00:00', 'SN3')];
    expect(matchExternalRenameFingerprints(missing, fresh)).toEqual([]);
  });

  it('both serials absent but dates equal still matches', () => {
    const missing = [candidate('IMG_7.CR3', 2_000_000, '2024-03-10T08:00:00', null)];
    const fresh = [candidate('IMG_8.CR3', 2_000_000, '2024-03-10T08:00:00', null)];
    expect(matchExternalRenameFingerprints(missing, fresh)).toEqual([
      { missingFilename: 'IMG_7.CR3', newFilename: 'IMG_8.CR3' },
    ]);
  });

  it('a serial present on only one side is a disagreement, not a wildcard', () => {
    const missing = [candidate('IMG_9.CR3', 1_800_000, '2024-04-01T09:00:00', 'SN5')];
    const fresh = [candidate('IMG_10.CR3', 1_800_000, '2024-04-01T09:00:00', null)];
    expect(matchExternalRenameFingerprints(missing, fresh)).toEqual([]);
  });

  it('two same-fingerprint candidates decline as ambiguous', () => {
    const missing = [
      candidate('IMG_11.CR3', 1_000_000, '2024-05-05T05:05:00', 'SN4'),
      candidate('IMG_12.CR3', 1_000_000, '2024-05-05T05:05:00', 'SN4'),
    ];
    const fresh = [candidate('IMG_13.CR3', 1_000_000, '2024-05-05T05:05:00', 'SN4')];
    expect(matchExternalRenameFingerprints(missing, fresh)).toEqual([]);
  });

  it('a clean, unambiguous size+date+serial match reconciles', () => {
    const missing = [candidate('IMG_14.CR3', 6_500_000, '2024-08-08T08:08:00', 'SN9')];
    const fresh = [candidate('IMG_15.CR3', 6_500_000, '2024-08-08T08:08:00', 'SN9')];
    expect(matchExternalRenameFingerprints(missing, fresh)).toEqual([
      { missingFilename: 'IMG_14.CR3', newFilename: 'IMG_15.CR3' },
    ]);
  });

  it('returns [] for empty inputs on either side', () => {
    expect(matchExternalRenameFingerprints([], [])).toEqual([]);
    expect(matchExternalRenameFingerprints([candidate('a', 1, '2024-01-01T00:00:00')], [])).toEqual(
      [],
    );
    expect(matchExternalRenameFingerprints([], [candidate('b', 1, '2024-01-01T00:00:00')])).toEqual(
      [],
    );
  });
});
