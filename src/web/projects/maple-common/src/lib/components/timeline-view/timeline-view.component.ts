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
