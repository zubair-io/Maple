/**
 * Unit tests for `PeopleBulkController`'s merge-suggestion actions
 * (`mergeSuggestionInto` / `dismissSuggestion`). The class is plain TS with
 * deps threaded through the constructor (see the file header comment), so
 * it's testable with fake deps and no TestBed — the same approach
 * `people.vm.spec.ts` uses for pure logic in this feature.
 */
import { signal } from '@angular/core';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiPerson, ApiPersonDetail } from '@maple-common';
import { PeopleBulkController, type PeopleBulkDeps } from './people-bulk.controller';
import type { Tone } from './people.vm';

function detailWithSuggestion(overrides: Partial<ApiPersonDetail> = {}): ApiPersonDetail {
  return {
    id: 'current',
    name: 'Current Person',
    coverAssetId: null,
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    faces: [],
    suggestedMerge: {
      personId: 'other',
      name: 'Other Person',
      coverAssetId: null,
      coverBbox: null,
      score: 0.9,
    },
    ...overrides,
  };
}

describe('PeopleBulkController — merge suggestions', () => {
  let mergePeople: ReturnType<typeof vi.fn>;
  let dismissMergeSuggestion: ReturnType<typeof vi.fn>;
  let toast: ReturnType<typeof vi.fn<(text: string, tone: Tone) => void>>;
  let selected: ReturnType<typeof signal<ApiPersonDetail | null>>;
  let controller: PeopleBulkController;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mergePeople = vi
      .fn()
      .mockResolvedValue({ id: 'current', name: 'Current Person', mergedCount: 1 });
    dismissMergeSuggestion = vi.fn().mockResolvedValue(undefined);
    toast = vi.fn<(text: string, tone: Tone) => void>();
    selected = signal<ApiPersonDetail | null>(detailWithSuggestion());
    confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);

    const deps: PeopleBulkDeps = {
      store: { mergePeople, dismissMergeSuggestion } as unknown as PeopleBulkDeps['store'],
      router: { navigate: vi.fn() } as unknown as PeopleBulkDeps['router'],
      people: signal<ApiPerson[]>([]),
      namedPeople: signal<ApiPerson[]>([]),
      selected,
      toast,
    };
    controller = new PeopleBulkController(deps);
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('mergeSuggestionInto: merges the suggested person INTO the current page (fixed direction)', async () => {
    controller.mergeSuggestionInto();
    await Promise.resolve();
    await Promise.resolve();

    expect(confirmSpy).toHaveBeenCalled();
    expect(mergePeople).toHaveBeenCalledWith('current', ['other']);
  });

  it('mergeSuggestionInto: no-ops when there is no open person or no suggestion', () => {
    selected.set(null);
    controller.mergeSuggestionInto();
    expect(mergePeople).not.toHaveBeenCalled();

    selected.set(detailWithSuggestion({ suggestedMerge: null }));
    controller.mergeSuggestionInto();
    expect(mergePeople).not.toHaveBeenCalled();
  });

  it('dismissSuggestion: calls the store with (current id, suggested id)', async () => {
    await controller.dismissSuggestion();
    expect(dismissMergeSuggestion).toHaveBeenCalledWith('current', 'other');
    expect(toast).not.toHaveBeenCalled();
  });

  it('dismissSuggestion: toasts on failure', async () => {
    dismissMergeSuggestion.mockRejectedValueOnce(new Error('boom'));
    await controller.dismissSuggestion();
    expect(toast).toHaveBeenCalledWith('boom', 'error');
  });
});
