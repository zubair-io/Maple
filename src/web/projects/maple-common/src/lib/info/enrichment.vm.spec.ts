// Tests for the pure VM module behind the enrichment surface.
//
// Replaces the old `detail-panel/info-tab.vm.spec.ts` (file deleted in #634
// alongside the `<maple-info-tab>` consolidation). Same shape: pull plain
// functions, build minimal fixtures, assert behaviour without spinning up
// TestBed — that's the whole point of the split.

import { describe, it, expect } from 'vitest';
import {
  detailChanged,
  formatRollups,
  showPlaceSection,
  skipReasonLabel,
  stageStatus,
  taggedFaces,
  untaggedFaceCount,
} from './enrichment.vm';
import type { ApiAssetDetail, ApiEnrichmentStageState } from '../api/bun-api-backend.service';

// ─── Fixture builders ────────────────────────────────────────────────────

function stageState(overrides: Partial<ApiEnrichmentStageState> = {}): ApiEnrichmentStageState {
  return {
    done_at: null,
    locked_by: null,
    lease_expires_at: null,
    attempts: 0,
    last_error: null,
    version: null,
    dead_letter_at: null,
    ...overrides,
  };
}

function detail(overrides: Partial<ApiAssetDetail> = {}): ApiAssetDetail {
  return {
    id: 'a1',
    folder_id: 'f1',
    filename: 'IMG_0001.cr3',
    abs_path: '/lib/IMG_0001.cr3',
    size: 0,
    mtime: 0,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-05-19T00:00:00Z',
    place: null,
    faces: [],
    description: null,
    description_meta: null,
    ocr_text: null,
    ocr_meta: null,
    vision: null,
    vision_meta: null,
    transcript: null,
    is_screenshot: null,
    enrichment: {
      geocode: stageState(),
      face: stageState(),
      describe: stageState(),
    },
    ...overrides,
  };
}

// ─── formatRollups / taggedFaces / untaggedFaceCount ─────────────────────

describe('formatRollups', () => {
  it('joins locality + region with a comma', () => {
    expect(formatRollups({ locality: 'Berkeley', region: 'California' })).toBe(
      'Berkeley, California',
    );
  });
  it('drops null entries', () => {
    expect(formatRollups({ locality: 'Berkeley', region: null })).toBe('Berkeley');
    expect(formatRollups({ locality: null, region: 'California' })).toBe('California');
  });
  it('falls back to "(no rollup)" when both are null', () => {
    expect(formatRollups({ locality: null, region: null })).toBe('(no rollup)');
  });
});

describe('taggedFaces / untaggedFaceCount', () => {
  const d = detail({
    faces: [
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: 'p1', confidence: 0.9 },
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9 },
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: 'p2', confidence: 0.9 },
      { bbox: { x: 0, y: 0, w: 1, h: 1 }, person_id: null, confidence: 0.9 },
    ],
  });
  it('returns only the tagged faces, normalised to {person_id}', () => {
    expect(taggedFaces(d)).toEqual([{ person_id: 'p1' }, { person_id: 'p2' }]);
  });
  it('counts the untagged faces', () => {
    expect(untaggedFaceCount(d)).toBe(2);
  });
});

// ─── showPlaceSection ────────────────────────────────────────────────────

describe('showPlaceSection', () => {
  it('returns true when place is set', () => {
    const d = detail({
      place: {
        source: 's',
        geocoder_version: 0,
        geocoded_at: '',
        lat: 0,
        lon: 0,
        display_name: 'X',
        address: {},
        pois: [],
        rollups: { locality: null, region: null, country_code: null },
        search_blob: '',
      },
    });
    expect(showPlaceSection(d)).toBe(true);
  });
  it('returns true when place is null but geocode has not run', () => {
    const d = detail(); // place=null, done_at=null
    expect(showPlaceSection(d)).toBe(true);
  });
  it('returns false when place is null AND geocode has run (no-place result)', () => {
    const d = detail({
      enrichment: {
        geocode: stageState({ done_at: '2026-05-19T00:00:00Z' }),
        face: stageState(),
        describe: stageState(),
      },
    });
    expect(showPlaceSection(d)).toBe(false);
  });
});

// ─── detailChanged ───────────────────────────────────────────────────────

describe('detailChanged', () => {
  it('returns true when either side is null', () => {
    expect(detailChanged(null, detail())).toBe(true);
    expect(detailChanged(detail(), null)).toBe(true);
  });
  it('returns false when nothing on the watched fields moved', () => {
    expect(detailChanged(detail(), detail())).toBe(false);
  });
  it('returns true when done_at flips', () => {
    const a = detail();
    const b = detail({
      enrichment: {
        geocode: stageState({ done_at: '2026-05-19T00:00:00Z' }),
        face: stageState(),
        describe: stageState(),
      },
    });
    expect(detailChanged(a, b)).toBe(true);
  });
  it('returns true when version bumps', () => {
    const a = detail();
    const b = detail({
      enrichment: {
        geocode: stageState(),
        face: stageState({ version: 1 }),
        describe: stageState(),
      },
    });
    expect(detailChanged(a, b)).toBe(true);
  });
  it('returns true when dead_letter_at appears', () => {
    const a = detail();
    const b = detail({
      enrichment: {
        geocode: stageState(),
        face: stageState(),
        describe: stageState({ dead_letter_at: '2026-05-19T00:00:00Z' }),
      },
    });
    expect(detailChanged(a, b)).toBe(true);
  });
});

// ─── skipReasonLabel ─────────────────────────────────────────────────────

describe('skipReasonLabel', () => {
  it('maps known reasons to friendly labels', () => {
    expect(skipReasonLabel('no-gps')).toBe('No GPS');
    expect(skipReasonLabel('image-missing')).toBe('No thumbnail');
    expect(skipReasonLabel('thumb-missing-foo')).toBe('No thumbnail');
    expect(skipReasonLabel('thumb-undecodable: bad PNG')).toBe('Thumbnail unreadable');
  });
  it('falls back to "Skipped" for unknown reasons', () => {
    expect(skipReasonLabel('mystery')).toBe('Skipped');
  });
});

// ─── stageStatus ─────────────────────────────────────────────────────────

describe('stageStatus', () => {
  it('returns failed when dead_letter_at is set, regardless of other fields', () => {
    const r = stageStatus(
      stageState({
        dead_letter_at: '2026-05-19T00:00:00Z',
        last_error: 'boom',
        done_at: '2026-05-19T00:00:00Z', // intentionally also set
      }),
      false,
    );
    expect(r.kind).toBe('failed');
    expect(r.label).toBe('Failed');
    expect(r.tooltip).toBe('boom');
  });

  it('returns skipped (with friendly label) when last_error starts with "skip:"', () => {
    const r = stageStatus(
      stageState({
        last_error: 'skip: no-gps',
        done_at: '2026-05-19T00:00:00Z',
      }),
      false,
    );
    expect(r.kind).toBe('skipped');
    expect(r.label).toBe('No GPS');
    expect(r.tooltip).toBe('skip: no-gps');
  });

  it('returns complete (blank label) when done_at is set without errors', () => {
    const r = stageStatus(stageState({ done_at: '2026-05-19T00:00:00Z' }), false);
    expect(r.kind).toBe('complete');
    expect(r.label).toBe('');
  });

  it('returns paused when worker is paused and stage is pending', () => {
    const r = stageStatus(stageState(), true);
    expect(r.kind).toBe('paused');
    expect(r.label).toBe('Worker paused');
  });

  it('returns running when there is a live lease', () => {
    const now = 1_700_000_000_000;
    const r = stageStatus(
      stageState({
        locked_by: 'worker-1',
        lease_expires_at: new Date(now + 60_000).toISOString(),
      }),
      false,
      now,
    );
    expect(r.kind).toBe('running');
    expect(r.label).toBe('Running…');
  });

  it('returns pending when the lease has expired', () => {
    const now = 1_700_000_000_000;
    const r = stageStatus(
      stageState({
        locked_by: 'worker-1',
        lease_expires_at: new Date(now - 60_000).toISOString(),
      }),
      false,
      now,
    );
    expect(r.kind).toBe('pending');
    expect(r.label).toBe('Pending');
  });

  it('returns pending in the default case', () => {
    const r = stageStatus(stageState(), false);
    expect(r.kind).toBe('pending');
    expect(r.label).toBe('Pending');
  });
});
