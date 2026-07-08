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
//     <button>s mounted (DOM virtualisation) — rendering for a visible
//     month is delegated to TimelineMonthComponent.
//
//  5. Click → state.selectAsset('fs:' + abs_path) — same id contract as
//     the asset grid + Search page.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { errorMessage } from '../../util/errors';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { SearchResult, SearchService } from '../../api/search.service';
import { FilesystemBrowseService } from '../../api/filesystem-browse.service';
import { Asset } from '../../models/asset';
import { viewRouteCommands } from '../../addressing/route-address';
import { LibraryStateService } from '../../state/library-state.service';
import { TimelineStateService } from '../../state/timeline-state.service';
import { TimelineFilterRowComponent } from './timeline-filter-row.component';
import { RenderedMonth, TimelineMonthComponent } from './timeline-month.component';
import { TimelineRegisterSectionDirective } from './timeline-register-section.directive';
import {
  MonthGroup,
  PhotoVm,
  YearGroup,
  buildGroups,
  countInMonth,
  foldPage,
  monthKey,
} from './timeline-view.utils';

// Page size for the single sorted /api/search query.
const PAGE_SIZE = 200;

interface RenderedYear {
  year: number;
  count: number;
  months: RenderedMonth[];
}

/** Used only when a month collapses before it was ever measured (should be
 * rare — new months default to visible until proven otherwise). */
const FALLBACK_PLACEHOLDER_HEIGHT = 200;

/** Camera "Make Model" label, or undefined when neither field is present.
 * Extracted from `_hydrate` so its ternary/filter chain doesn't count
 * against that method's own complexity. */
function cameraLabel(camera: PhotoVm['camera']): string | undefined {
  if (!camera) return undefined;
  const label = [camera.make, camera.model].filter((s): s is string => !!s).join(' ');
  return label.length > 0 ? label : undefined;
}

/** Maps the search API's numeric flag to the Asset model's string union. */
function flagToAssetFlag(flag: PhotoVm['flag']): Asset['flag'] {
  if (flag === 1) return 'pick';
  if (flag === -1) return 'reject';
  return 'unflagged';
}

@Component({
  selector: 'app-timeline-view',
  standalone: true,
  imports: [TimelineFilterRowComponent, TimelineMonthComponent, TimelineRegisterSectionDirective],
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
    effect(() => this._syncResizeObserver());
    effect(() => this._syncScrollObservers());
  }

  ngAfterViewInit(): void {}

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.visibilityObserver?.disconnect();
    this.sentinelObserver?.disconnect();
    if (this.fetchDebounce !== null) clearTimeout(this.fetchDebounce);
  }

  // ── Reactive observer setup ──────────────────────────────────────────────
  // Fires whenever `containerRef` resolves (populated only after the first
  // render).
  private _syncResizeObserver(): void {
    const ref = this.containerRef();
    if (!ref || this.ro) return;
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) this.containerWidth.set(e.contentRect.width);
    });
    this.ro.observe(ref.nativeElement);
    this.containerWidth.set(ref.nativeElement.clientWidth || 800);
  }

  /** `scrollContainerRef` may toggle in and out of the DOM as
   * `hasPathPrefix` flips, so this tracks the current root element and
   * rebuilds both observers whenever it changes — otherwise an observer
   * ends up rooted at a detached node and never fires intersections. */
  private _syncScrollObservers(): void {
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

    // Visibility observer: tracks which month sections are on-screen so the
    // template can virtualise photo DOM, and records the last measured
    // height of a section the moment it leaves the viewport so its
    // placeholder doesn't distort scroll position.
    this.visibilityObserver = new IntersectionObserver(
      (entries) => this._onVisibilityIntersect(entries),
      { root: el, rootMargin: TimelineViewComponent.VISIBLE_ROOT_MARGIN, threshold: 0 },
    );

    // Sentinel observer: fetches the next page when the bottom marker
    // scrolls near the viewport. One instance, one target — there is
    // exactly one fetch frontier now, not one per month.
    this.sentinelObserver = new IntersectionObserver(
      (entries) => this._onSentinelIntersect(entries),
      {
        root: el,
        rootMargin: TimelineViewComponent.SENTINEL_ROOT_MARGIN,
        threshold: 0,
      },
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
  }

  private _onVisibilityIntersect(entries: IntersectionObserverEntry[]): void {
    const newlyVisibleKeys = this._applyVisibilityEntries(entries);
    if (newlyVisibleKeys.length === 0) return;
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

  /** Applies one batch of visibility-observer entries to `_visibleMonths`
   * (and records measured heights for months that just left the viewport).
   * Returns the keys that newly became visible this batch. */
  private _applyVisibilityEntries(entries: IntersectionObserverEntry[]): string[] {
    const newlyVisibleKeys: string[] = [];
    this._visibleMonths.update((prev) => {
      let next: Set<string> | null = null;
      for (const entry of entries) {
        const change = this._visibilityChangeFor(entry, prev);
        if (!change) continue;
        next ??= new Set(prev);
        if (change.action === 'added') {
          next.add(change.key);
          newlyVisibleKeys.push(change.key);
        } else {
          next.delete(change.key);
          this._recordMeasuredHeight(change.key, entry.boundingClientRect.height);
        }
      }
      return next ?? prev;
    });
    return newlyVisibleKeys;
  }

  /** Whether one intersection-observer entry flips its month key into or
   * out of `prev` — `null` when the entry's intersection state already
   * matches `prev` (nothing to do) or its element carries no valid
   * year/month dataset. */
  private _visibilityChangeFor(
    entry: IntersectionObserverEntry,
    prev: ReadonlySet<string>,
  ): { key: string; action: 'added' | 'removed' } | null {
    const key = this._monthKeyOf(entry.target as HTMLElement);
    if (key === null) return null;
    const has = prev.has(key);
    if (entry.isIntersecting === has) return null;
    return { key, action: entry.isIntersecting ? 'added' : 'removed' };
  }

  private _monthKeyOf(el: HTMLElement): string | null {
    const year = Number(el.dataset['year']);
    const month = Number(el.dataset['month']);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
    return monthKey(year, month);
  }

  private _recordMeasuredHeight(key: string, height: number): void {
    if (height <= 0) return;
    this._measuredHeights.update((m) => {
      const next = new Map(m);
      next.set(key, height);
      return next;
    });
  }

  private _onSentinelIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (untracked(() => this.pageLoading()) || untracked(() => this.isDone())) continue;
      void this._fetchPage();
    }
  }

  /** Called from `[appTimelineRegisterSection]` on each month section. */
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

  /** Called from `[appTimelineRegisterSection]` on the bottom fetch
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
      this._markMonthsVisible(r.results);
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

  /** New months default to visible — they were just fetched because the
   * user scrolled near them, so there's no reason to render them as
   * off-screen placeholders before the visibility observer even sees them. */
  private _markMonthsVisible(results: SearchResult[]): void {
    this._visibleMonths.update((prev) => {
      let next: Set<string> | null = null;
      for (const row of results) {
        if (!row.captured_at) continue;
        const d = new Date(row.captured_at);
        const key = monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
        if (!prev.has(key)) {
          next ??= new Set(prev);
          next.add(key);
        }
      }
      return next ?? prev;
    });
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
      this._years.update((years) => this._withThumbUrl(years, p.abs_path, url));
    } catch {
      // Silent — gradient placeholder stays.
    }
  }

  private _withThumbUrl(years: YearGroup[], absPath: string, url: string): YearGroup[] {
    return years.map((y) => ({
      ...y,
      months: y.months.map((m) => this._monthWithThumbUrl(m, absPath, url)),
    }));
  }

  private _monthWithThumbUrl(m: MonthGroup, absPath: string, url: string): MonthGroup {
    let changed = false;
    const groups = new Map<string, PhotoVm[]>();
    for (const [name, photos] of m.groups) {
      const idx = photos.findIndex((x) => x.abs_path === absPath);
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
    const camera = cameraLabel(p.camera);
    this.state.hydrateSelfHostedFsAsset(p.id, {
      filename: p.filename,
      rating: p.rating,
      flag: flagToAssetFlag(p.flag),
      colorLabel: (p.color_label || null) as Asset['colorLabel'],
      camera,
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
  trackYear = (_: number, y: RenderedYear): number => y.year;
  trackMonth = (_: number, m: RenderedMonth): string => monthKey(m.year, m.month);
}
