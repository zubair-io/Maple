/**
 * Unit tests for `PeopleDetailController`'s thumb-prefetch and
 * merge-suggestion "Compare faces" logic (#2078). Plain-TS controller with
 * deps threaded through the constructor, so it's testable with fake deps
 * and no TestBed — the same approach `people-bulk.controller.spec.ts` uses.
 */
import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiPerson, ApiPersonDetail, ApiPersonFace } from '@maple-common';
import { PeopleDetailController, type PeopleDetailDeps } from './people-detail.controller';
import type { Tone } from './people.vm';

function face(assetId: string): ApiPersonFace {
  return {
    assetId,
    faceIndex: 0,
    absPath: `/lib/${assetId}.jpg`,
    bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
  };
}

function detailWith(overrides: Partial<ApiPersonDetail> = {}): ApiPersonDetail {
  return {
    id: 'current',
    name: 'Current Person',
    coverAssetId: 'cover-current',
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    faces: [face('f1')],
    suggestedMerge: {
      personId: 'other',
      name: 'Other Person',
      coverAssetId: 'cover-other',
      coverBbox: null,
      score: 0.9,
    },
    ...overrides,
  };
}

describe('PeopleDetailController — thumb prefetch + compare faces', () => {
  let ensure: ReturnType<typeof vi.fn>;
  let getPerson: ReturnType<typeof vi.fn>;
  let toast: ReturnType<typeof vi.fn<(text: string, tone: Tone) => void>>;
  let selected: ReturnType<typeof signal<ApiPersonDetail | null>>;
  let people: ReturnType<typeof signal<ApiPerson[]>>;
  let controller: PeopleDetailController;

  beforeEach(() => {
    ensure = vi.fn();
    getPerson = vi.fn(() => of(detailWith({ id: 'other', faces: [face('of1'), face('of2')] })));
    toast = vi.fn<(text: string, tone: Tone) => void>();
    selected = signal<ApiPersonDetail | null>(detailWith());
    people = signal<ApiPerson[]>([]);

    const deps: PeopleDetailDeps = {
      store: {} as PeopleDetailDeps['store'],
      api: { getPerson } as unknown as PeopleDetailDeps['api'],
      router: { navigate: vi.fn() } as unknown as PeopleDetailDeps['router'],
      selected,
      people,
      thumbs: { ensure } as unknown as PeopleDetailDeps['thumbs'],
      selectedFaces: signal<ReadonlySet<string>>(new Set()),
      clearSelection: vi.fn(),
      bulkBusy: signal<number>(0),
      toast,
    };
    controller = new PeopleDetailController(deps);
  });

  it('prefetchDetailThumbs ensures the face grid, the own cover, and the suggestion cover (apiId fallback)', () => {
    controller.prefetchDetailThumbs();

    expect(ensure).toHaveBeenCalledWith('/lib/f1.jpg', null, '/lib/f1.jpg', 'f1');
    expect(ensure).toHaveBeenCalledWith('apiId:cover-current', null, null, 'cover-current');
    expect(ensure).toHaveBeenCalledWith('apiId:cover-other', null, null, 'cover-other');
  });

  it('prefetchDetailThumbs resolves through the list row cover key when the person is loaded', () => {
    people.set([
      {
        id: 'other',
        name: 'Other Person',
        faceCount: 3,
        coverAbsPath: '/lib/other-cover.jpg',
        coverAddress: null,
        coverAssetId: 'cover-other',
        coverBbox: null,
        createdAt: '',
        updatedAt: '',
        hasMergeSuggestion: true,
      } as ApiPerson,
    ]);

    controller.prefetchDetailThumbs();

    // The SAME key `coverThumbUrl(original)` reads: the list row's coverKey.
    expect(ensure).toHaveBeenCalledWith(
      '/lib/other-cover.jpg',
      null,
      '/lib/other-cover.jpg',
      'cover-other',
    );
  });

  it('toggleSuggestionFaces fetches one face page, ensures its thumbs, and collapses on re-toggle', async () => {
    await controller.toggleSuggestionFaces();

    expect(getPerson).toHaveBeenCalledWith('other', { offset: 0, limit: 12 });
    expect(controller.suggestionFaces()?.length).toBe(2);
    expect(ensure).toHaveBeenCalledWith('/lib/of1.jpg', null, '/lib/of1.jpg', 'of1');

    await controller.toggleSuggestionFaces();
    expect(controller.suggestionFaces()).toBeNull();
    expect(getPerson).toHaveBeenCalledTimes(1);
  });

  it('toggleSuggestionFaces no-ops without a suggestion and toasts on fetch failure', async () => {
    selected.set(detailWith({ suggestedMerge: null }));
    await controller.toggleSuggestionFaces();
    expect(getPerson).not.toHaveBeenCalled();

    selected.set(detailWith());
    getPerson.mockReturnValueOnce(throwError(() => new Error('boom')));
    await controller.toggleSuggestionFaces();
    expect(toast).toHaveBeenCalledWith('boom', 'error');
    expect(controller.suggestionFaces()).toBeNull();
    expect(controller.suggestionFacesLoading()).toBe(false);
  });

  it('discards an in-flight face page when the suggestion changes before it resolves', async () => {
    const deferred = new Subject<ApiPersonDetail>();
    getPerson.mockReturnValueOnce(deferred.asObservable());

    const togglePromise = controller.toggleSuggestionFaces();
    // User navigates to a different person while the fetch is in flight.
    selected.set(
      detailWith({
        id: 'someone-else',
        suggestedMerge: {
          personId: 'different',
          name: 'Different Person',
          coverAssetId: null,
          coverBbox: null,
          score: 0.8,
        },
      }),
    );
    deferred.next(detailWith({ id: 'other', faces: [face('stale')] }));
    deferred.complete();
    await togglePromise;

    // The stale payload must not open the strip under the new banner.
    expect(controller.suggestionFaces()).toBeNull();
    expect(controller.suggestionFacesLoading()).toBe(false);
  });

  it('prefetchDetailThumbs collapses the strip when the suggestion changes or clears', async () => {
    await controller.toggleSuggestionFaces();
    expect(controller.suggestionFaces()).not.toBeNull();

    // Same suggestion → strip survives a detail refresh.
    controller.prefetchDetailThumbs();
    expect(controller.suggestionFaces()).not.toBeNull();

    // Suggestion cleared server-side (dismissed / merged) → strip collapses.
    selected.set(detailWith({ suggestedMerge: null }));
    controller.prefetchDetailThumbs();
    expect(controller.suggestionFaces()).toBeNull();
  });
});
