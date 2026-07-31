// Shared fixtures for the TimelineView specs. Extracted so
// `timeline-view.component.spec.ts` (pagination → Year/Month/folder fold) and
// `timeline-view.click.spec.ts` (#2404 click semantics) share one set of stubs
// rather than carrying duplicate copies — and so neither file has to grow past
// the changed-file LOC headroom gate.

import { of } from 'rxjs';
import { vi } from 'vitest';

import type { SearchParams, SearchResponse, SearchResult } from '../../api/search.service';
import { STORAGE_KEYS } from '../../util/typed-storage';

/** Drop every persisted browse preference so one spec can't leak into the next. */
export const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};

export function makeResult(id: string, absPath: string, capturedAt: string): SearchResult {
  return {
    id,
    address: null,
    _id: id,
    folder_id: 'f1',
    abs_path: absPath,
    filename: absPath.split('/').pop()!,
    size: 100,
    mtime: 0,
    captured_at: capturedAt,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focal_length: null,
    rating: 0,
    flag: 0,
    color_label: '',
  };
}

export class SearchStub {
  searchCalls: SearchParams[] = [];
  pages: SearchResponse[] = [];
  search = vi.fn((p: SearchParams) => {
    this.searchCalls.push(p);
    const page = p.page ?? 0;
    const resp = this.pages[page] ?? { total: 0, page, limit: p.limit ?? 200, results: [] };
    return of(resp);
  });
  // Called by TimelineViewComponent through DI, never from the spec source, so
  // static analysis can't see the reference.
  // fallow-ignore-next-line unused-class-member
  facets = vi.fn(() => of({}));
}

export class FsBrowseStub {
  // Same as SearchStub.facets — reached via DI from the component under test.
  // fallow-ignore-next-line unused-class-member
  getThumbBlobUrl = vi.fn(() => Promise.resolve('blob:fake'));
}

/** Timeline mounts tiles through IntersectionObserver and measures with
 * ResizeObserver; jsdom has neither, so both specs install inert stubs.
 *
 * Returns a teardown that puts the originals back (including `undefined`,
 * which is what jsdom actually starts with). Call it from `afterEach` —
 * leaving the stubs installed pollutes `globalThis` for anything that runs
 * afterwards, whether that's a suite relying on the real implementations or
 * one asserting their absence. */
export function installObserverStubs(): () => void {
  const g = globalThis as { ResizeObserver?: unknown; IntersectionObserver?: unknown };
  const originalResize = g.ResizeObserver;
  const originalIntersection = g.IntersectionObserver;

  const observerStub = class {
    constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  const roStub = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  g.ResizeObserver = roStub;
  g.IntersectionObserver = observerStub;

  return () => {
    g.ResizeObserver = originalResize;
    g.IntersectionObserver = originalIntersection;
  };
}
