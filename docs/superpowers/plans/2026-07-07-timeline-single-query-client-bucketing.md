# Timeline Single-Query Client-Side Bucketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web Timeline view's two-stage fetch (`/api/search/buckets` aggregation + per-month `/api/search` page fetch) with a single sorted, paginated `/api/search` query whose Year → Month → folder grouping is computed entirely client-side as pages load.

**Architecture:** `TimelineViewComponent` fetches `/api/search` with `sort=captured_desc`, `page`, `limit` — one page at a time, starting at page 0 on every scope/filter change. Each page's results fold into an accumulated `YearGroup[]` structure (pure functions in a new `timeline-view.utils.ts`) instead of seeding a pre-fetched bucket list. A single bottom-of-list sentinel `IntersectionObserver` triggers the next page fetch; the existing per-month visibility `IntersectionObserver` keeps DOM virtualization (collapsing offscreen months to a placeholder), now sized from each section's own last-measured height instead of an estimate.

**Tech Stack:** Angular 21 standalone components, signals, RxJS `firstValueFrom`, Vitest.

## Global Constraints

- No changes to `GET /api/search` or `GET /api/search/buckets` on the server — this is a client-only change (see spec's Non-goals).
- No changes to `TimelineStateService` — its `params()`/`pathPrefix()` contract (fixed in #1823/#1824) is reused as-is; `sort: 'captured_desc'` is added at the `SearchService.search()` call site in the component, matching how `sort`/`limit`/`page` were already appended at call sites before this change (the old `_fetchMonth` did the same for `sort`/`limit`).
- `TimelineScrubberComponent` is deleted entirely — no replacement UI element for scrubbing/jump-to-month.
- The "N untimed photos hidden" banner is removed — no replacement count query.
- Preserve every other visible behavior: Year/Month headers with counts, per-month folder sub-grouping with collapse/expand, photo click/double-click, thumbnail loading, DOM virtualization of offscreen months.
- Format with Prettier before committing (`bun run format` from `src/web`, or `bun x prettier --write <files>`), matching this repo's CI `format-check` gate.

---

## File Structure

- **Create:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.ts` — pure, Angular-free grouping/folding functions (the actual "client-side bucketing" logic), independently unit-testable.
- **Create:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.spec.ts` — unit tests for the above.
- **Modify:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.ts` — full rewrite of the fetch/state logic; keeps the same class name, selector, and directive export.
- **Modify:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.html` — template rewrite to match the new component API and drop the scrubber.
- **Modify:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.spec.ts` — full rewrite of the test suite for the new fetch flow.
- **Delete:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.ts`
- **Delete:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.html`
- **Delete:** `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.scss`
- **Modify:** `src/web/projects/maple-common/src/public-api.ts` — remove the `timeline-scrubber.component` barrel export line.

`timeline-view.component.scss` is unchanged — no new/removed CSS classes are needed (the sentinel and month sections reuse existing Tailwind utility classes inline).

---

## Task 1: Client-side grouping utilities

**Files:**
- Create: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.ts`
- Test: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.spec.ts`

**Interfaces:**
- Consumes: `SearchResult` from `../../api/search.service` (existing type — `id`, `_id`, `folder_id`, `abs_path`, `filename`, `size`, `mtime`, `captured_at`, `camera`, `lens`, `iso`, `aperture`, `shutter`, `focal_length`, `rating`, `flag`, `color_label`, `has_xmp?`, `hidden?`).
- Produces (used by Task 2):
  - `interface PhotoVm extends SearchResult { thumbUrl: string | null }`
  - `interface MonthGroup { year: number; month: number; groups: Map<string, PhotoVm[]> }`
  - `interface YearGroup { year: number; months: MonthGroup[] }`
  - `function monthKey(year: number, month: number): string`
  - `function folderNameFor(absPath: string, prefix: string): string`
  - `function foldPage(years: YearGroup[], results: SearchResult[], prefix: string, thumbCache: ReadonlyMap<string, string>): YearGroup[]`
  - `function countInMonth(m: MonthGroup): number`
  - `function buildGroups(m: MonthGroup): Array<{ folderName: string; photos: PhotoVm[] }>`

- [ ] **Step 1: Write the failing test file**

Create `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.spec.ts`:

```ts
// Pure-function tests for the client-side Year -> Month -> folder folding
// logic that replaces the /api/search/buckets aggregation. See
// docs/superpowers/specs/2026-07-07-timeline-single-query-client-bucketing-design.md.

import { describe, it, expect } from 'vitest';
import { SearchResult } from '../../api/search.service';
import { buildGroups, countInMonth, foldPage, folderNameFor, monthKey } from './timeline-view.utils';

function makeResult(
  id: string,
  absPath: string,
  capturedAt: string | null,
): SearchResult {
  return {
    id,
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

describe('folderNameFor', () => {
  it('returns "." for a photo directly in the scoped folder', () => {
    expect(folderNameFor('/Lib/2026/photo.dng', '/Lib/2026/')).toBe('.');
  });

  it('returns the immediate subfolder name for a nested photo', () => {
    expect(folderNameFor('/Lib/2026/vacation/photo.dng', '/Lib/2026/')).toBe('vacation');
  });

  it('falls back to the first path segment when the prefix does not match', () => {
    expect(folderNameFor('/Other/photo.dng', '/Lib/2026/')).toBe('Other');
  });
});

describe('foldPage', () => {
  it('opens a new year and month group on the first page', () => {
    const r = makeResult('a', '/Lib/2026/photo.dng', '2026-05-10T00:00:00.000Z');
    const years = foldPage([], [r], '/Lib/', new Map());
    expect(years).toHaveLength(1);
    expect(years[0]!.year).toBe(2026);
    expect(years[0]!.months).toHaveLength(1);
    expect(years[0]!.months[0]!.month).toBe(5);
    expect(countInMonth(years[0]!.months[0]!)).toBe(1);
  });

  it('extends the trailing month when the next result continues it', () => {
    const r1 = makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z');
    const r2 = makeResult('b', '/Lib/2026/b.dng', '2026-05-05T00:00:00.000Z');
    const years = foldPage([], [r1, r2], '/Lib/', new Map());
    expect(years).toHaveLength(1);
    expect(years[0]!.months).toHaveLength(1);
    expect(countInMonth(years[0]!.months[0]!)).toBe(2);
  });

  it('opens a new month group when a page spans a month boundary', () => {
    const r1 = makeResult('a', '/Lib/2026/a.dng', '2026-05-01T00:00:00.000Z');
    const r2 = makeResult('b', '/Lib/2026/b.dng', '2026-04-30T00:00:00.000Z');
    const years = foldPage([], [r1, r2], '/Lib/', new Map());
    expect(years).toHaveLength(1);
    expect(years[0]!.months.map((m) => m.month)).toEqual([5, 4]);
  });

  it('opens a new year group when a page spans a year boundary', () => {
    const r1 = makeResult('a', '/Lib/2026/a.dng', '2026-01-05T00:00:00.000Z');
    const r2 = makeResult('b', '/Lib/2025/b.dng', '2025-12-20T00:00:00.000Z');
    const years = foldPage([], [r1, r2], '/Lib/', new Map());
    expect(years.map((y) => y.year)).toEqual([2026, 2025]);
  });

  it('extends an already-accumulated structure across two fold calls (page 0 then page 1)', () => {
    const page0 = [makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z')];
    const page1 = [makeResult('b', '/Lib/2026/b.dng', '2026-05-01T00:00:00.000Z')];
    const afterPage0 = foldPage([], page0, '/Lib/', new Map());
    const afterPage1 = foldPage(afterPage0, page1, '/Lib/', new Map());
    expect(afterPage1).toHaveLength(1);
    expect(countInMonth(afterPage1[0]!.months[0]!)).toBe(2);
  });

  it('does not mutate a snapshot taken from a prior fold', () => {
    const page0 = [makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z')];
    const afterPage0 = foldPage([], page0, '/Lib/', new Map());
    const snapshotMonth = afterPage0[0]!.months[0]!;
    const page1 = [makeResult('b', '/Lib/2026/b.dng', '2026-05-01T00:00:00.000Z')];
    foldPage(afterPage0, page1, '/Lib/', new Map());
    expect(snapshotMonth.groups.get('.')).toHaveLength(1);
  });

  it('skips a result with no captured_at', () => {
    const r = makeResult('a', '/Lib/2026/a.dng', null);
    const years = foldPage([], [r], '/Lib/', new Map());
    expect(years).toHaveLength(0);
  });

  it('seeds thumbUrl from the thumb cache when present', () => {
    const r = makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z');
    const cache = new Map([['/Lib/2026/a.dng', 'blob:cached']]);
    const years = foldPage([], [r], '/Lib/', cache);
    expect(years[0]!.months[0]!.groups.get('.')![0]!.thumbUrl).toBe('blob:cached');
  });

  it('leaves thumbUrl null when the thumb cache has no entry', () => {
    const r = makeResult('a', '/Lib/2026/a.dng', '2026-05-10T00:00:00.000Z');
    const years = foldPage([], [r], '/Lib/', new Map());
    expect(years[0]!.months[0]!.groups.get('.')![0]!.thumbUrl).toBeNull();
  });
});

describe('buildGroups', () => {
  it('sorts folder groups by most-recent photo descending', () => {
    const older = makeResult('a', '/Lib/2026/old-folder/a.dng', '2026-05-01T00:00:00.000Z');
    const newer = makeResult('b', '/Lib/2026/new-folder/b.dng', '2026-05-15T00:00:00.000Z');
    const years = foldPage([], [newer, older], '/Lib/', new Map());
    const groups = buildGroups(years[0]!.months[0]!);
    expect(groups.map((g) => g.folderName)).toEqual(['new-folder', 'old-folder']);
  });
});

describe('monthKey', () => {
  it('formats a stable, unique key per year/month', () => {
    expect(monthKey(2026, 5)).toBe('2026-5');
    expect(monthKey(2026, 5)).not.toBe(monthKey(2025, 5));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/web && bunx vitest run projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.spec.ts
```

Expected: FAIL — `Cannot find module './timeline-view.utils'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.ts`:

```ts
// Pure, Angular-free helpers for TimelineViewComponent's client-side
// Year -> Month -> folder grouping. This is the mechanism that replaces
// the old /api/search/buckets aggregation — see
// docs/superpowers/specs/2026-07-07-timeline-single-query-client-bucketing-design.md.
// Kept dependency-free so the fold/merge logic can be unit-tested without
// TestBed.

import { SearchResult } from '../../api/search.service';

export interface PhotoVm extends SearchResult {
  thumbUrl: string | null;
}

/** One calendar month's photos, grouped by the folder name immediately
 * under the search scope's `pathPrefix`. */
export interface MonthGroup {
  year: number;
  month: number;
  /** Map<folderName, photos[]> — '.' means "directly in the scoped folder." */
  groups: Map<string, PhotoVm[]>;
}

export interface YearGroup {
  year: number;
  months: MonthGroup[];
}

export function monthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

/** Splits an absolute path into the folder name immediately under `prefix`.
 * A photo directly inside the scoped folder (no further subfolder) buckets
 * under '.'. */
export function folderNameFor(absPath: string, prefix: string): string {
  const rest = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
  const segments = rest.split('/').filter((s) => s.length > 0);
  return segments.length > 1 ? segments[0]! : '.';
}

/**
 * Folds one page of `/api/search` results (already sorted `captured_desc`
 * by the server) into the accumulated Year -> Month structure. Extends the
 * trailing year/month group when a result continues it, opens a new one
 * when it doesn't — this is the entire client-side bucketing mechanism.
 *
 * Rows with no `captured_at` are skipped defensively; the caller always
 * queries with `hasCapturedAt: true`, so this should never trigger.
 *
 * Returns a new array. Only the trailing year (and, within it, the
 * trailing month) is ever cloned/mutated per row — every earlier
 * year/month object keeps its prior identity, so `computed()` consumers
 * over the untouched parts don't needlessly recompute.
 */
export function foldPage(
  years: YearGroup[],
  results: SearchResult[],
  prefix: string,
  thumbCache: ReadonlyMap<string, string>,
): YearGroup[] {
  const next = years.slice();
  for (const r of results) {
    if (!r.captured_at) continue;
    const d = new Date(r.captured_at);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const folderName = folderNameFor(r.abs_path, prefix);
    const thumbUrl = thumbCache.get(r.abs_path) ?? null;
    const vm: PhotoVm = { ...r, thumbUrl };

    let lastYear = next[next.length - 1];
    if (!lastYear || lastYear.year !== year) {
      lastYear = { year, months: [] };
      next.push(lastYear);
    } else {
      lastYear = { ...lastYear, months: lastYear.months.slice() };
      next[next.length - 1] = lastYear;
    }

    let lastMonth = lastYear.months[lastYear.months.length - 1];
    if (!lastMonth || lastMonth.month !== month) {
      lastMonth = { year, month, groups: new Map() };
      lastYear.months.push(lastMonth);
    } else {
      lastMonth = { ...lastMonth, groups: new Map(lastMonth.groups) };
      lastYear.months[lastYear.months.length - 1] = lastMonth;
    }

    const existing = lastMonth.groups.get(folderName);
    lastMonth.groups.set(folderName, existing ? [...existing, vm] : [vm]);
  }
  return next;
}

/** Total photo count across every folder group in a month. */
export function countInMonth(m: MonthGroup): number {
  let n = 0;
  for (const photos of m.groups.values()) n += photos.length;
  return n;
}

function maxCapturedTime(photos: PhotoVm[]): number {
  let max = 0;
  for (const p of photos) {
    if (!p.captured_at) continue;
    const t = Date.parse(p.captured_at);
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return max;
}

/** Render-ready folder groups for one month, sorted by each folder's most
 * recent photo (descending) — matches the original per-month behaviour. */
export function buildGroups(m: MonthGroup): Array<{ folderName: string; photos: PhotoVm[] }> {
  const names = Array.from(m.groups.keys());
  names.sort((a, b) => maxCapturedTime(m.groups.get(b)!) - maxCapturedTime(m.groups.get(a)!));
  return names.map((folderName) => ({ folderName, photos: m.groups.get(folderName)! }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd src/web && bunx vitest run projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.spec.ts
```

Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.ts \
        src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.spec.ts
git commit -m "feat(web): add pure client-side Year/Month folding utilities for Timeline"
```

---

## Task 2: Rewrite TimelineViewComponent to single-query pagination, remove the scrubber

**Files:**
- Modify: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.ts`
- Modify: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.html`
- Modify: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.spec.ts`
- Delete: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.ts`
- Delete: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.html`
- Delete: `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.scss`
- Modify: `src/web/projects/maple-common/src/public-api.ts`

**Interfaces:**
- Consumes: `PhotoVm`, `MonthGroup`, `YearGroup`, `monthKey`, `foldPage`, `countInMonth`, `buildGroups` from `./timeline-view.utils` (Task 1). `TimelineStateService.params()` / `.pathPrefix()` (unchanged, existing). `SearchService.search()` (existing — unchanged signature).
- Produces: `TimelineViewComponent` keeps its existing public surface used elsewhere (`registerMonthSection`, `onPhotoClick`, `onPhotoDblClick`, `groupKey`/`isCollapsed`/`toggleGroup`, `monthLabel`/`folderGroupLabel`, `trackYear`/`trackMonth`/`trackGroup`/`trackPhoto`) plus new: `registerSentinel(el: HTMLElement | null): void`, `retryPage(): void`, `pageLoading: WritableSignal<boolean>`, `pageError: WritableSignal<string | null>`, `isDone: Signal<boolean>`. Removed: `buckets`, `bucketsLoading`, `bucketsError`, `untimedHint`, `scrubberBuckets`, `onScrubberJump`, `retryMonth`.

This is one atomic task because the `.ts`, `.html`, and `.spec.ts` must all change together to keep the component compiling and its tests meaningful at every commit.

- [ ] **Step 1: Replace `timeline-view.component.ts` in full**

Replace the entire contents of `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.ts` with:

```ts
// TimelineView — Year → Month → folder grouped scroller.
//
// Data flow (see docs/superpowers/specs/2026-07-07-timeline-single-query-client-bucketing-design.md):
//
//  1. On mount + on every (pathPrefix | filters | searchQuery) change
//     (debounced 250 ms): reset accumulated state and fetch page 0 of
//     SearchService.search, sorted captured_desc. A generation counter
//     drops stale responses from a since-abandoned scope.
//
//  2. Each page's results are folded into an ordered Year → Month →
//     folder structure (`foldPage`, in timeline-view.utils.ts) — no
//     server-side aggregation, no pre-declared bucket list. The
//     rendered list simply ends where loaded data ends.
//
//  3. A sentinel element after the last rendered group is watched by an
//     IntersectionObserver; scrolling it into view fetches the next
//     page (guarded by an in-flight check and `loaded < total`).
//
//  4. A second IntersectionObserver tracks which month sections are
//     currently on-screen so off-screen ones collapse to a
//     last-measured-height placeholder instead of keeping their photo
//     <button>s mounted (DOM virtualisation).
//
//  5. Click → state.selectAsset('fs:' + abs_path) — same id contract as
//     the asset grid + Search page.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { errorMessage } from '../../util/errors';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SearchService } from '../../api/search.service';
import { FilesystemBrowseService } from '../../api/filesystem-browse.service';
import { Asset } from '../../models/asset';
import { viewRouteCommands } from '../../addressing/route-address';
import { LibraryStateService } from '../../state/library-state.service';
import { TimelineStateService } from '../../state/timeline-state.service';
import { TimelineFilterRowComponent } from './timeline-filter-row.component';
import {
  MonthGroup,
  PhotoVm,
  YearGroup,
  buildGroups,
  countInMonth,
  foldPage,
  monthKey,
} from './timeline-view.utils';

/** Tiny structural-style directive that registers an element with a
 * caller-supplied callback. Used for both month sections (DOM
 * virtualisation) and the bottom fetch sentinel — lets the template
 * express "call me back with my element" without inventing a
 * `@ViewChildren` plumb. */
@Directive({
  selector: '[appTimelineRegisterMonth]',
  standalone: true,
})
export class TimelineRegisterMonthDirective implements OnInit {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  appTimelineRegisterMonth = input.required<(el: HTMLElement) => void>();

  ngOnInit(): void {
    this.appTimelineRegisterMonth()(this.el.nativeElement);
  }
}

// Page size for the single sorted /api/search query.
const PAGE_SIZE = 200;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

interface RenderedMonth {
  year: number;
  month: number;
  count: number;
  groups: Array<{ folderName: string; photos: PhotoVm[] }>;
  isVisible: boolean;
  placeholderHeight: number;
}

interface RenderedYear {
  year: number;
  count: number;
  months: RenderedMonth[];
}

/** Used only when a month collapses before it was ever measured (should be
 * rare — new months default to visible until proven otherwise). */
const FALLBACK_PLACEHOLDER_HEIGHT = 200;

@Component({
  selector: 'app-timeline-view',
  standalone: true,
  imports: [TimelineFilterRowComponent, TimelineRegisterMonthDirective],
  templateUrl: './timeline-view.component.html',
  styleUrl: './timeline-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineViewComponent implements AfterViewInit, OnDestroy {
  readonly scrollContainerRef = viewChild<ElementRef<HTMLElement>>('scrollContainer');
  readonly containerRef = viewChild<ElementRef<HTMLElement>>('container');

  private readonly router = inject(Router);
  private readonly search = inject(SearchService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  readonly state = inject(LibraryStateService);
  readonly timeline = inject(TimelineStateService);

  // ── Accumulated data ──────────────────────────────────────────────────────
  private readonly _years = signal<YearGroup[]>([]);
  private readonly _nextPage = signal(0);
  private readonly _total = signal<number | null>(null);
  private readonly _loadedCount = signal(0);
  readonly pageLoading = signal<boolean>(false);
  readonly pageError = signal<string | null>(null);

  /** Width of the inner container — drives photo cell layout. */
  readonly containerWidth = signal<number>(800);

  // ── Generation counter — bumped on every scope/filter change so a
  // stale in-flight fetch from an abandoned scope can't clobber state. ──
  private fetchGen = 0;
  private fetchDebounce: ReturnType<typeof setTimeout> | null = null;

  // ── Thumb cache ──────────────────────────────────────────────────────────
  private thumbCache = new Map<string, string>();

  // ── Folder-group collapse (session-local; not persisted) ────────────────
  private readonly _collapsed = signal<Set<string>>(new Set());

  // ── IntersectionObservers ────────────────────────────────────────────────
  private visibilityObserver?: IntersectionObserver;
  private sentinelObserver?: IntersectionObserver;
  private observerRoot?: HTMLElement;
  private observedSections = new WeakSet<HTMLElement>();
  private pendingObserve = new Set<HTMLElement>();
  private pendingSentinel: HTMLElement | null = null;

  // ── Resize observer ──────────────────────────────────────────────────────
  private ro?: ResizeObserver;

  // ── Viewport-based DOM virtualisation ───────────────────────────────────
  // Newly-folded months default to visible (they were just fetched because
  // the user scrolled near them), and the visibility observer takes over
  // from there — flipping a month out of `_visibleMonths` the moment it
  // scrolls off-screen, and recording its last measured height so the
  // placeholder that replaces it doesn't distort scroll position.
  private readonly _visibleMonths = signal<Set<string>>(new Set());
  private readonly _measuredHeights = signal<Map<string, number>>(new Map());

  private static readonly VISIBLE_ROOT_MARGIN = '300px 0px';
  private static readonly SENTINEL_ROOT_MARGIN = '400px 0px';

  readonly isDone = computed(() => {
    const total = this._total();
    return total !== null && this._loadedCount() >= total;
  });

  // ── Derived: year-grouped, render-ready structure ────────────────────────
  readonly years = computed<RenderedYear[]>(() => {
    const raw = this._years();
    const visible = this._visibleMonths();
    const measured = this._measuredHeights();
    return raw.map<RenderedYear>((y) => ({
      year: y.year,
      count: y.months.reduce((sum, m) => sum + countInMonth(m), 0),
      months: y.months.map<RenderedMonth>((m) => {
        const key = monthKey(m.year, m.month);
        const isVisible = visible.has(key);
        return {
          year: m.year,
          month: m.month,
          count: countInMonth(m),
          groups: isVisible ? buildGroups(m) : [],
          isVisible,
          placeholderHeight: measured.get(key) ?? FALLBACK_PLACEHOLDER_HEIGHT,
        };
      }),
    }));
  });

  // ── Empty-state surface flags ────────────────────────────────────────────
  readonly hasPathPrefix = computed(() => this.timeline.pathPrefix() !== null);
  readonly isEmpty = computed(
    () => this.isDone() && this._years().length === 0 && !this.pageError(),
  );

  constructor() {
    effect(() => {
      const params = this.timeline.params();
      void params;
      this._scheduleReset();
    });

    // Reactive ResizeObserver setup — fires whenever `containerRef`
    // resolves (populated only after the first render).
    effect(() => {
      const ref = this.containerRef();
      if (!ref || this.ro) return;
      this.ro = new ResizeObserver((entries) => {
        for (const e of entries) this.containerWidth.set(e.contentRect.width);
      });
      this.ro.observe(ref.nativeElement);
      this.containerWidth.set(ref.nativeElement.clientWidth || 800);
    });

    // Reactive IntersectionObserver setup. `scrollContainerRef` may toggle
    // in and out of the DOM as `hasPathPrefix` flips, so this effect
    // tracks the current root element and rebuilds both observers
    // whenever it changes — otherwise an observer ends up rooted at a
    // detached node and never fires intersections.
    effect(() => {
      const ref = this.scrollContainerRef();
      const el = ref?.nativeElement;
      if (!el) {
        this.visibilityObserver?.disconnect();
        this.sentinelObserver?.disconnect();
        this.visibilityObserver = undefined;
        this.sentinelObserver = undefined;
        this.observerRoot = undefined;
        this.observedSections = new WeakSet();
        this._visibleMonths.set(new Set());
        return;
      }
      if (this.visibilityObserver && this.observerRoot === el) return;
      this.visibilityObserver?.disconnect();
      this.sentinelObserver?.disconnect();
      this.observedSections = new WeakSet();
      this.observerRoot = el;

      // Visibility observer: tracks which month sections are on-screen so
      // the template can virtualise photo DOM, and records the last
      // measured height of a section the moment it leaves the viewport so
      // its placeholder doesn't distort scroll position.
      this.visibilityObserver = new IntersectionObserver(
        (entries) => {
          const newlyVisibleKeys: string[] = [];
          this._visibleMonths.update((prev) => {
            let next: Set<string> | null = null;
            for (const entry of entries) {
              const target = entry.target as HTMLElement;
              const year = Number(target.dataset['year']);
              const month = Number(target.dataset['month']);
              if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
              const key = monthKey(year, month);
              const has = prev.has(key);
              if (entry.isIntersecting && !has) {
                if (!next) next = new Set(prev);
                next.add(key);
                newlyVisibleKeys.push(key);
              } else if (!entry.isIntersecting && has) {
                if (!next) next = new Set(prev);
                next.delete(key);
                const height = entry.boundingClientRect.height;
                if (height > 0) {
                  this._measuredHeights.update((m) => {
                    const nm = new Map(m);
                    nm.set(key, height);
                    return nm;
                  });
                }
              }
            }
            return next ?? prev;
          });
          if (newlyVisibleKeys.length > 0) {
            const raw = untracked(() => this._years());
            for (const key of newlyVisibleKeys) {
              const [yStr, mStr] = key.split('-');
              const y = raw.find((yr) => yr.year === Number(yStr));
              const m = y?.months.find((mo) => mo.month === Number(mStr));
              if (!m) continue;
              for (const photos of m.groups.values()) {
                for (const p of photos) void this._loadThumb(p);
              }
            }
          }
        },
        { root: el, rootMargin: TimelineViewComponent.VISIBLE_ROOT_MARGIN, threshold: 0 },
      );

      // Sentinel observer: fetches the next page when the bottom marker
      // scrolls near the viewport. One instance, one target — there is
      // exactly one fetch frontier now, not one per month.
      this.sentinelObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (untracked(() => this.pageLoading()) || untracked(() => this.isDone())) continue;
            void this._fetchPage();
          }
        },
        { root: el, rootMargin: TimelineViewComponent.SENTINEL_ROOT_MARGIN, threshold: 0 },
      );

      for (const node of this.pendingObserve) {
        this.observedSections.add(node);
        this.visibilityObserver.observe(node);
      }
      this.pendingObserve.clear();
      if (this.pendingSentinel) {
        this.sentinelObserver.observe(this.pendingSentinel);
        this.pendingSentinel = null;
      }
    });
  }

  ngAfterViewInit(): void {}

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.visibilityObserver?.disconnect();
    this.sentinelObserver?.disconnect();
    if (this.fetchDebounce !== null) clearTimeout(this.fetchDebounce);
  }

  /** Called from `[appTimelineRegisterMonth]` on each month section. */
  registerMonthSection = (el: HTMLElement | null): void => {
    if (!el) return;
    if (this.observedSections.has(el)) return;
    this.observedSections.add(el);
    if (this.visibilityObserver) {
      this.visibilityObserver.observe(el);
    } else {
      this.pendingObserve.add(el);
    }
  };

  /** Called from `[appTimelineRegisterMonth]` on the bottom fetch
   * sentinel — same registration pattern as month sections, targeting the
   * sentinel observer instead. */
  registerSentinel = (el: HTMLElement | null): void => {
    if (!el) return;
    if (this.sentinelObserver) {
      this.sentinelObserver.observe(el);
    } else {
      this.pendingSentinel = el;
    }
  };

  // ── Fetch ─────────────────────────────────────────────────────────────────
  private _scheduleReset(): void {
    if (this.fetchDebounce !== null) clearTimeout(this.fetchDebounce);
    this.fetchDebounce = setTimeout(() => {
      this.fetchGen++;
      this._years.set([]);
      this._visibleMonths.set(new Set());
      this._measuredHeights.set(new Map());
      this._nextPage.set(0);
      this._total.set(null);
      this._loadedCount.set(0);
      this.pageError.set(null);
      const params = untracked(() => this.timeline.params());
      if (!params) return;
      void this._fetchPage();
    }, 250);
  }

  private async _fetchPage(): Promise<void> {
    const params = untracked(() => this.timeline.params());
    const prefix = untracked(() => this.timeline.pathPrefix());
    if (!params || !prefix) return;
    const gen = this.fetchGen;
    const page = untracked(() => this._nextPage());
    this.pageLoading.set(true);
    this.pageError.set(null);
    try {
      const r = await firstValueFrom(
        this.search.search({ ...params, sort: 'captured_desc', page, limit: PAGE_SIZE }),
      );
      if (gen !== this.fetchGen) return;
      this._total.set(r.total);
      this._loadedCount.update((n) => n + r.results.length);
      this._years.update((years) => foldPage(years, r.results, prefix, this.thumbCache));
      this._visibleMonths.update((prev) => {
        let next: Set<string> | null = null;
        for (const row of r.results) {
          if (!row.captured_at) continue;
          const d = new Date(row.captured_at);
          const key = monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
          if (!prev.has(key)) {
            if (!next) next = new Set(prev);
            next.add(key);
          }
        }
        return next ?? prev;
      });
      this._nextPage.set(page + 1);
      for (const row of r.results) {
        const cached = this.thumbCache.get(row.abs_path);
        void this._loadThumb({ ...row, thumbUrl: cached ?? null });
      }
    } catch (err) {
      if (gen !== this.fetchGen) return;
      this.pageError.set(errorMessage(err));
    } finally {
      if (gen === this.fetchGen) this.pageLoading.set(false);
    }
  }

  /** Retries the current fetch frontier — the page that just failed,
   * since `_nextPage` only advances on a successful fetch. */
  retryPage(): void {
    void this._fetchPage();
  }

  // ── Thumbnail loading ────────────────────────────────────────────────────
  private async _loadThumb(p: PhotoVm): Promise<void> {
    if (p.thumbUrl) return;
    if (this.thumbCache.has(p.abs_path)) return;
    try {
      const url = await this.fsBrowse.getThumbBlobUrl(p.abs_path, 512);
      this.thumbCache.set(p.abs_path, url);
      this._years.update((years) =>
        years.map((y) => ({
          ...y,
          months: y.months.map((m) => {
            let changed = false;
            const groups = new Map<string, PhotoVm[]>();
            for (const [name, photos] of m.groups) {
              const idx = photos.findIndex((x) => x.abs_path === p.abs_path);
              if (idx === -1) {
                groups.set(name, photos);
                continue;
              }
              const updated = photos.slice();
              updated[idx] = { ...updated[idx]!, thumbUrl: url };
              groups.set(name, updated);
              changed = true;
            }
            return changed ? { ...m, groups } : m;
          }),
        })),
      );
    } catch {
      // Silent — gradient placeholder stays.
    }
  }

  // ── Folder-group collapse helpers ────────────────────────────────────────
  groupKey(year: number, month: number, folderName: string): string {
    return `${year}-${month}-${folderName}`;
  }

  isCollapsed(year: number, month: number, folderName: string): boolean {
    return this._collapsed().has(this.groupKey(year, month, folderName));
  }

  toggleGroup(year: number, month: number, folderName: string): void {
    const key = this.groupKey(year, month, folderName);
    this._collapsed.update((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── Click handlers ───────────────────────────────────────────────────────
  onPhotoClick(p: PhotoVm, e: MouseEvent): void {
    this._hydrate(p);
    this.state.selectAsset(p.id, e.metaKey || e.ctrlKey, e.shiftKey);
  }

  onPhotoDblClick(p: PhotoVm): void {
    this._hydrate(p);
    this.state.selectAsset(p.id);
    void this.router.navigate(viewRouteCommands(p.id));
  }

  /** Project a Timeline search hit into the `assets` signal so the detail
   * panel has metadata to render. Without this, photos from sub-folders
   * that haven't been listed via /api/fs/dir would `selectAsset` to a
   * non-existent record. */
  private _hydrate(p: PhotoVm): void {
    const camera = p.camera
      ? [p.camera.make, p.camera.model].filter((s): s is string => !!s).join(' ')
      : undefined;
    this.state.hydrateSelfHostedFsAsset(p.id, {
      filename: p.filename,
      rating: p.rating,
      flag: p.flag === 1 ? 'pick' : p.flag === -1 ? 'reject' : 'unflagged',
      colorLabel: (p.color_label || null) as Asset['colorLabel'],
      camera: camera && camera.length > 0 ? camera : undefined,
      lens: p.lens ?? undefined,
      focalLength: p.focal_length != null ? `${p.focal_length}mm` : undefined,
      aperture: p.aperture != null ? `f/${p.aperture}` : undefined,
      shutter: p.shutter ?? undefined,
      iso: p.iso ?? undefined,
      capturedAt: p.captured_at ?? undefined,
      size: p.size,
    });
  }

  // ── Template helpers ─────────────────────────────────────────────────────
  monthLabel = (m: number): string => MONTH_NAMES[m - 1] ?? String(m);
  folderGroupLabel = (name: string): string => (name === '.' ? '(this folder)' : name);

  trackYear = (_: number, y: RenderedYear): number => y.year;
  trackMonth = (_: number, m: RenderedMonth): string => monthKey(m.year, m.month);
  trackGroup = (_: number, g: { folderName: string; photos: PhotoVm[] }): string => g.folderName;
  trackPhoto = (_: number, p: PhotoVm): string => p.id;
}
```

- [ ] **Step 2: Replace `timeline-view.component.html` in full**

Replace the entire contents of `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.html` with:

```html
<div class="flex h-full w-full flex-col bg-bg" #container>
  <app-timeline-filter-row />

  @if (!hasPathPrefix()) {
    <div class="flex flex-1 items-center justify-center text-[12px] text-text-muted">
      Pick a library or folder to see a timeline.
    </div>
  } @else {
    <!-- The scrollContainer is mounted whenever a path scope exists, so the
         IntersectionObservers' root never gets unmounted mid-fetch. -->
    <div class="timeline-scroll flex-1 overflow-y-auto" #scrollContainer>
      @if (pageError(); as err) {
        <div
          class="flex flex-col items-center justify-center gap-2 px-3 py-8 text-center text-[12px] text-error-text"
        >
          <span>{{ err }}</span>
          <button
            type="button"
            class="cursor-pointer rounded border-[0.5px] border-border bg-surface-hover px-2 py-1 text-text-main hover:border-text-muted"
            (click)="retryPage()"
          >
            Retry
          </button>
        </div>
      } @else if (pageLoading() && years().length === 0) {
        <div class="flex h-full items-center justify-center text-[12px] text-text-muted">
          Loading timeline…
        </div>
      } @else if (isEmpty()) {
        <div class="flex h-full items-center justify-center text-[12px] text-text-muted">
          No photos in this scope match your filters.
        </div>
      } @else {
        @for (y of years(); track trackYear($index, y)) {
          <div class="year-group">
            <div
              class="sticky top-0 z-10 flex h-11 items-end border-b-[0.5px] border-border bg-bg px-3 pb-1 text-[20px] font-semibold text-text-main"
            >
              {{ y.year }}
              <span class="ml-2 text-[11px] font-normal text-text-muted">
                {{ y.count }} photo{{ y.count === 1 ? '' : 's' }}
              </span>
            </div>

            @for (m of y.months; track trackMonth($index, m)) {
              <div
                class="month-section"
                [attr.data-year]="m.year"
                [attr.data-month]="m.month"
                [appTimelineRegisterMonth]="registerMonthSection"
              >
                <div
                  class="sticky top-11 z-[9] flex h-8 items-center border-b-[0.5px] border-border bg-bg px-4 text-[13px] font-medium text-text-main"
                >
                  {{ monthLabel(m.month) }}
                  <span class="ml-2 text-[11px] font-normal text-text-muted">{{ m.count }}</span>
                </div>

                @if (!m.isVisible) {
                  <!-- Off-screen placeholder — preserves scroll height
                       without mounting any <img>/<button>s. Height is this
                       section's own last-measured height, not an estimate. -->
                  <div [style.height.px]="m.placeholderHeight" aria-hidden="true"></div>
                } @else {
                  @for (g of m.groups; track trackGroup($index, g)) {
                    <div class="folder-group">
                      <button
                        type="button"
                        class="folder-group-header flex h-6 w-full items-center px-3 text-left text-[11px] uppercase tracking-[0.05em] text-text-muted hover:text-text-main"
                        [attr.aria-expanded]="!isCollapsed(m.year, m.month, g.folderName)"
                        (click)="toggleGroup(m.year, m.month, g.folderName)"
                      >
                        <span
                          class="mr-1.5 inline-block h-2.5 w-2.5 transition-transform duration-[120ms]"
                          [class.rotate-90]="!isCollapsed(m.year, m.month, g.folderName)"
                          aria-hidden="true"
                        >
                          <!-- Chevron-right SVG; rotates 90° when expanded -->
                          <svg viewBox="0 0 10 10" class="block h-full w-full" fill="currentColor">
                            <path d="M3 1.5L6.5 5L3 8.5L4 9.5L8.5 5L4 0.5L3 1.5Z" />
                          </svg>
                        </span>
                        {{ folderGroupLabel(g.folderName) }}
                        <span class="ml-2 normal-case tracking-normal"
                          >({{ g.photos.length }})</span
                        >
                      </button>
                      @if (!isCollapsed(m.year, m.month, g.folderName)) {
                        <div class="flex flex-wrap gap-1 px-4 pb-2">
                          @for (p of g.photos; track trackPhoto($index, p)) {
                            <button
                              type="button"
                              class="timeline-photo relative h-[140px] w-[140px] flex-shrink-0 cursor-pointer overflow-hidden rounded-sm border-[0.5px] border-border bg-surface-hover transition-[border-color] duration-[120ms] hover:border-primary"
                              [class.is-selected]="state.focusedAssetId() === p.id"
                              [class.dimmed]="p.hidden"
                              [attr.aria-label]="p.filename"
                              (click)="onPhotoClick(p, $event)"
                              (dblclick)="onPhotoDblClick(p)"
                            >
                              @if (p.thumbUrl) {
                                <img
                                  class="block h-full w-full object-cover"
                                  [src]="p.thumbUrl"
                                  alt=""
                                  loading="lazy"
                                  decoding="async"
                                />
                              }
                              @if (p.hidden) {
                                <div
                                  class="absolute left-1 top-1 flex h-[14px] px-1 items-center justify-center rounded-[3px] border-[0.5px] border-error-text bg-error-bg/90 backdrop-blur-[4px] text-[8px] font-semibold text-error-text"
                                >
                                  HIDDEN
                                </div>
                              }
                              @if (p.rating > 0) {
                                <div
                                  class="absolute bottom-1 right-1 rounded bg-black/45 px-1 py-0.5 text-[10px] text-white backdrop-blur-[4px]"
                                >
                                  {{ p.rating }}★
                                </div>
                              }
                            </button>
                          }
                        </div>
                      }
                    </div>
                  }
                }
              </div>
            }
          </div>
        }

        @if (!isDone()) {
          <div
            class="flex h-10 items-center justify-center text-[10px] uppercase tracking-[0.05em] text-text-muted"
            [appTimelineRegisterMonth]="registerSentinel"
          >
            @if (pageLoading()) {
              Loading more…
            }
          </div>
        }
      }
    </div>
  }
</div>
```

- [ ] **Step 3: Delete the scrubber component files**

```bash
git rm src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.ts \
       src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.html \
       src/web/projects/maple-common/src/lib/components/timeline-view/timeline-scrubber.component.scss
```

- [ ] **Step 4: Remove the scrubber's barrel export**

In `src/web/projects/maple-common/src/public-api.ts`, delete this line:

```ts
export * from './lib/components/timeline-view/timeline-scrubber.component';
```

- [ ] **Step 5: Replace `timeline-view.component.spec.ts` in full**

Replace the entire contents of `src/web/projects/maple-common/src/lib/components/timeline-view/timeline-view.component.spec.ts` with:

```ts
// TimelineView — component-level test exercising the single-query
// pagination -> client-side Year/Month/folder fold path. See
// docs/superpowers/specs/2026-07-07-timeline-single-query-client-bucketing-design.md.

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { TimelineViewComponent } from './timeline-view.component';
import { LibraryStateService } from '../../state/library-state.service';
import { TimelineStateService } from '../../state/timeline-state.service';
import { SearchService, SearchParams, SearchResponse, SearchResult } from '../../api/search.service';
import { FilesystemBrowseService } from '../../api/filesystem-browse.service';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { API_BASE_URL } from '../../api/api-base-url.token';
import { STORAGE_KEYS } from '../../util/typed-storage';
import { provideLibrarySource } from '../../addressing/library-source-provider';

const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};
beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

function makeResult(id: string, absPath: string, capturedAt: string): SearchResult {
  return {
    id,
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

class SearchStub {
  searchCalls: SearchParams[] = [];
  pages: SearchResponse[] = [];
  search = vi.fn((p: SearchParams) => {
    this.searchCalls.push(p);
    const page = p.page ?? 0;
    const resp = this.pages[page] ?? { total: 0, page, limit: p.limit ?? 200, results: [] };
    return of(resp);
  });
  facets = vi.fn(() => of({}));
}

class FsBrowseStub {
  getThumbBlobUrl = vi.fn(() => Promise.resolve('blob:fake'));
}

describe('TimelineViewComponent', () => {
  let library: LibraryStateService;
  let timeline: TimelineStateService;
  let searchStub: SearchStub;

  // Recording stub so tests can verify observer wiring AND manually fire
  // intersection callbacks (there's no real IntersectionObserver in
  // jsdom). visibilityObserver is constructed first, sentinelObserver
  // second — `ioCalls[1]` is always the sentinel one.
  let ioCalls: Array<{ root: Element | null; callbacks: IntersectionObserverCallback }> = [];
  let ioObservedTargets: HTMLElement[] = [];

  beforeEach(() => {
    ioCalls = [];
    ioObservedTargets = [];
    const ioStub = class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        ioCalls.push({ root: (options?.root as Element | null) ?? null, callbacks: callback });
      }
      observe(t: Element): void {
        ioObservedTargets.push(t as HTMLElement);
      }
      unobserve(): void {}
      disconnect(): void {}
    };
    const roStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = roStub;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = ioStub;

    searchStub = new SearchStub();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLibrarySource,
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: SearchService, useValue: searchStub },
        { provide: FilesystemBrowseService, useValue: new FsBrowseStub() },
      ],
    });
    library = TestBed.inject(LibraryStateService);
    timeline = TestBed.inject(TimelineStateService);
    library.registeredFolders.set([
      {
        id: 'lib-1',
        slug: 'lib',
        path: '/Lib',
        label: 'Lib',
        last_scan: null,
        file_count: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    library.sidebarTree.set([
      { kind: 'folder', id: 'lib:', label: 'Lib', count: null, absPath: '/Lib' },
    ]);
  });

  it('renders empty-state copy when no scope is selected', () => {
    library.selectedSourceId.set('');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Pick a library or folder');
    expect(searchStub.search).not.toHaveBeenCalled();
  });

  it('renders Year + Month headers from page 0 with a single sorted query, no buckets call', async () => {
    searchStub.pages = [
      {
        total: 3,
        page: 0,
        limit: 200,
        results: [
          makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z'),
          makeResult('b', '/Lib/2026/b.dng', '2026-05-10T00:00:00.000Z'),
          makeResult('c', '/Lib/2026/c.dng', '2026-04-01T00:00:00.000Z'),
        ],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();

    expect(searchStub.search).toHaveBeenCalledTimes(1);
    const params = searchStub.searchCalls[0]!;
    expect(params.libraryId).toBe('lib-1');
    expect(params.pathPrefix).toBeUndefined();
    expect(params.hasCapturedAt).toBe(true);
    expect(params.sort).toBe('captured_desc');
    expect(params.page).toBe(0);

    const html = fixture.nativeElement.textContent as string;
    expect(html).toContain('2026');
    expect(html).toContain('3 photos');
    expect(html).toContain('May');
    expect(html).toContain('April');
  });

  it('loads correctly when the newest photo in scope is years old (the original bug)', async () => {
    searchStub.pages = [
      {
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/vacation/a.dng', '2018-03-15T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();

    const html = fixture.nativeElement.textContent as string;
    expect(html).toContain('2018');
    expect(html).toContain('March');
    // No month-by-month walk: exactly one /api/search call surfaces the content.
    expect(searchStub.search).toHaveBeenCalledTimes(1);
  });

  it('fetches page 1 when the sentinel intersects and extends the right month group', async () => {
    searchStub.pages = [
      {
        total: 2,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      },
      {
        total: 2,
        page: 1,
        limit: 200,
        results: [makeResult('b', '/Lib/2026/b.dng', '2026-05-10T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    expect(searchStub.search).toHaveBeenCalledTimes(1);

    const sentinelEl = ioObservedTargets.find((el) => !el.dataset['year']);
    expect(sentinelEl).toBeDefined();
    const sentinelCallback = ioCalls[1]!.callbacks;
    sentinelCallback(
      [{ isIntersecting: true, target: sentinelEl } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(searchStub.search).toHaveBeenCalledTimes(2);
    expect(searchStub.searchCalls[1]!.page).toBe(1);
    const html = fixture.nativeElement.textContent as string;
    expect(html).toContain('2 photos');
  });

  it('retries the same page on error without reloading everything', async () => {
    let calls = 0;
    searchStub.search = vi.fn((p: SearchParams) => {
      searchStub.searchCalls.push(p);
      calls++;
      if (calls === 1) throw new Error('network down');
      return of({
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      });
    });
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('network down');

    fixture.componentInstance.retryPage();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(searchStub.searchCalls).toHaveLength(2);
    expect(searchStub.searchCalls[1]!.page).toBe(0);
    expect(fixture.nativeElement.textContent).toContain('2026');
  });

  it('wires both observers against the live #scrollContainer, not a stale ref', async () => {
    searchStub.pages = [
      {
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();

    expect(ioCalls.length).toBeGreaterThanOrEqual(2);
    const liveRoot = fixture.nativeElement.querySelector('.timeline-scroll') as HTMLElement;
    expect(liveRoot).not.toBeNull();
    for (const call of ioCalls) {
      expect(call.root).toBe(liveRoot);
    }
    const monthTargets = ioObservedTargets.filter((el) => el.dataset['year']);
    expect(monthTargets.length).toBeGreaterThanOrEqual(1);
    for (const el of monthTargets) {
      expect(liveRoot.contains(el)).toBe(true);
    }
  });

  it('resets and refetches page 0 when a filter signal changes (debounced)', async () => {
    searchStub.pages = [
      {
        total: 1,
        page: 0,
        limit: 200,
        results: [makeResult('a', '/Lib/2026/a.dng', '2026-05-20T00:00:00.000Z')],
      },
    ];
    library.selectedSourceId.set('lib:');
    const fixture = TestBed.createComponent(TimelineViewComponent);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    expect(searchStub.search).toHaveBeenCalledTimes(1);

    timeline.setMinRating(4);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 300));
    expect(searchStub.search).toHaveBeenCalledTimes(2);
    const last = searchStub.searchCalls[1]!;
    expect(last.rating).toBe(4);
    expect(last.page).toBe(0);
  });
});
```

- [ ] **Step 6: Run the full Angular test suite for maple-common**

```bash
cd src/web && bun x ng test Maple-common
```

Expected: all test files pass, including the new `timeline-view.component.spec.ts` and `timeline-view.utils.spec.ts`, with no leftover references to `TimelineScrubberComponent` or `SearchService.buckets()` anywhere in the suite. If anything fails, read the failure, fix the component/template/spec (not the test's expectations, unless the test itself has a mistake), and re-run.

- [ ] **Step 7: Format and verify no stray references remain**

```bash
cd src/web && bun x prettier --write \
  projects/maple-common/src/lib/components/timeline-view/timeline-view.component.ts \
  projects/maple-common/src/lib/components/timeline-view/timeline-view.component.html \
  projects/maple-common/src/lib/components/timeline-view/timeline-view.component.spec.ts \
  projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.ts \
  projects/maple-common/src/lib/components/timeline-view/timeline-view.utils.spec.ts \
  projects/maple-common/src/public-api.ts

grep -rn "TimelineScrubberComponent\|timeline-scrubber\|SearchService.*buckets\|\.buckets(" \
  projects/maple-common/src/lib/components/timeline-view/ projects/maple-common/src/public-api.ts
```

Expected: the `grep` prints nothing (no remaining references). If `SearchService.buckets()` itself (the method in `search.service.ts`) shows up, that's fine and expected to stay — only Timeline's *usage* of it must be gone.

- [ ] **Step 8: Commit**

```bash
git add src/web/projects/maple-common/src/lib/components/timeline-view/ \
        src/web/projects/maple-common/src/public-api.ts
git commit -m "feat(web): switch Timeline to single-query + client-side bucketing, drop scrubber"
```

---

## Task 3: Verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full web test suite one more time from a clean state**

```bash
cd src/web && bun x ng test Maple-common
```

Expected: all test files pass (this repo's baseline is ~98 files / ~925+ tests passing after the earlier Timeline `pathPrefix` fix — the count will grow slightly with the new `timeline-view.utils.spec.ts` file and stay flat or shrink slightly on `timeline-view.component.spec.ts` since the scrubber-jump test was removed and no new bucket-specific tests are added).

- [ ] **Step 2: Run the full PR-diff prettier check**

```bash
cd src/web && bun x prettier --check $(git diff --name-only main...HEAD -- . | grep -E '\.(ts|html|scss)$')
```

Expected: `All matched files use Prettier code style!`

- [ ] **Step 3: Manual verification in the dev server — the original reported bug**

Start the servers (see `.claude/launch.json` — `maple-api` on port 3000, `maple` on port 4201) and confirm a folder whose only photos are years old renders immediately with no month-by-month wait:

```bash
# Terminal 1
cd src/api && MAPLE_DEV_AUTH=1 MAPLE_INDEXER_AUTOSTART=0 PORT=3000 bun src/index.ts
# Terminal 2
cd src/web && bun x ng serve maple --port 4201
```

Register a throwaway library with a nested folder holding only old-dated content, e.g.:

```bash
mkdir -p /tmp/maple-verify-lib3/2026/vacation && touch /tmp/maple-verify-lib3/2026/vacation/.keep
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/dev-login -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -X POST http://localhost:3000/api/folders -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"path":"/tmp/maple-verify-lib3","label":"Verify Lib 3"}'
```

In the browser: select the registered library, drill into the nested folder, switch to Timeline mode. Confirm via the Network tab (or `preview_network`) that **exactly one** `/api/search` request fires (no `/api/search/buckets` request at all), and the folder's content renders under its actual Year/Month heading with no visible delay or "walking" behavior.

- [ ] **Step 4: Clean up the throwaway verification library**

```bash
rm -rf /tmp/maple-verify-lib3
```

(Leaving its now-dangling registration in the local dev DB is harmless and consistent with other throwaway entries already present from prior sessions — no cleanup endpoint call is required.)
