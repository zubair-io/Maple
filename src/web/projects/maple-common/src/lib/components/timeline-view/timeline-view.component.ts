// TimelineView — Year → Month → folder grouped scroller.
//
// Data flow (matching .archived-plans/specs/2026-05-06-timeline-view-design.md):
//
//  1. On mount + on every (pathPrefix | filters | searchQuery) change
//     (debounced 250 ms): call SearchService.buckets to refresh the
//     year/month aggregation. Generation counter drops stale responses.
//
//  2. Bucket response → flat TimelineItem list with placeholders for each
//     month. Heights are computed up-front from each bucket's count.
//
//  3. Each month section is wrapped in an IntersectionObserver so we only
//     fetch its photos once it scrolls into view. Results are bucketed
//     by folderName (path segment immediately under pathPrefix) and
//     merged into the items list.
//
//  4. Click → state.selectAsset('fs:' + abs_path) — same id contract as
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
import {
  SearchParams,
  SearchResult,
  SearchService,
  TimelineBucket,
  TimelineBuckets,
} from '../../api/search.service';
import { FilesystemBrowseService } from '../../api/filesystem-browse.service';
import { Asset } from '../../models/asset';
import { viewRouteCommands } from '../../addressing/route-address';
import { LibraryStateService } from '../../state/library-state.service';
import { TimelineStateService } from '../../state/timeline-state.service';
import { TimelineFilterRowComponent } from './timeline-filter-row.component';
import { TimelineScrubberComponent } from './timeline-scrubber.component';

/** Tiny structural-style directive that registers each month section's
 * native element with the parent component's IntersectionObserver. Lets
 * the template-side `[appTimelineRegisterMonth]` express "observe me"
 * without inventing a `@ViewChildren` plumb. */
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

// Per-month fetch page size. Matches the server's `/api/search` limit cap so a
// month loads in the fewest round-trips (one request per 500 photos).
const PAGE_SIZE = 500;

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

interface PhotoVm extends SearchResult {
  thumbUrl: string | null;
}

interface MonthData {
  bucket: TimelineBucket;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Map<folderName, photos[]> — preserves the in-month folder grouping. */
  groups: Map<string, PhotoVm[]>;
}

interface YearGroup {
  year: number;
  count: number;
  months: TimelineBucket[];
}

interface RenderedMonth {
  bucket: TimelineBucket;
  data: MonthData | null;
  groups: Array<{ folderName: string; photos: PhotoVm[] }>;
  /** True when this month's section is intersecting the visibility-observer
   * margin — only then do we render the photo <button>s. Off-screen months
   * collapse to a placeholder div. */
  isVisible: boolean;
  /** Estimated height in px for the placeholder div when isVisible is false.
   * Based on bucket count and estimated photos-per-row from container width. */
  placeholderHeight: number;
}

interface RenderedYear {
  year: number;
  count: number;
  months: RenderedMonth[];
}

@Component({
  selector: 'app-timeline-view',
  standalone: true,
  imports: [TimelineFilterRowComponent, TimelineScrubberComponent, TimelineRegisterMonthDirective],
  templateUrl: './timeline-view.component.html',
  styleUrl: './timeline-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineViewComponent implements AfterViewInit, OnDestroy {
  // Signal-based view queries — reactive, so an effect() can fire the
  // moment the @if/@else branch puts these elements in the DOM. The old
  // decorator-based `@ViewChild` fields had a timing race against
  // child-directive ngOnInit hooks inside @else blocks; signal queries
  // are guaranteed-correct by design.
  readonly scrollContainerRef = viewChild<ElementRef<HTMLElement>>('scrollContainer');
  readonly containerRef = viewChild<ElementRef<HTMLElement>>('container');

  private readonly router = inject(Router);
  private readonly search = inject(SearchService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  readonly state = inject(LibraryStateService);
  readonly timeline = inject(TimelineStateService);

  // ── Top-level data signals ───────────────────────────────────────────────
  readonly buckets = signal<TimelineBuckets | null>(null);
  readonly bucketsLoading = signal<boolean>(false);
  readonly bucketsError = signal<string | null>(null);

  /** Per-month data: keyed by `${year}-${month}`. */
  private readonly _monthData = signal<Map<string, MonthData>>(new Map());

  /** Width of the inner container — drives photo cell layout. */
  readonly containerWidth = signal<number>(800);

  // ── Generation counter for buckets requests ──────────────────────────────
  private bucketsGen = 0;
  private bucketsDebounce: ReturnType<typeof setTimeout> | null = null;

  // ── Per-month fetch generation counters ─────────────────────────────────
  private monthGens = new Map<string, number>();

  // ── Thumb cache ──────────────────────────────────────────────────────────
  private thumbCache = new Map<string, string>();

  // ── Folder-group collapse (session-local; not persisted) ────────────────
  // Keyed by `${year}-${month}-${folderName}`. A missing entry means
  // expanded — the default is "show photos" so the user sees content first.
  private readonly _collapsed = signal<Set<string>>(new Set());

  // ── IntersectionObserver for lazy-loaded months ──────────────────────────
  private monthObserver?: IntersectionObserver;
  private visibilityObserver?: IntersectionObserver;
  private observerRoot?: HTMLElement;
  private observedSections = new WeakSet<HTMLElement>();
  /** Elements that registered before the observers existed. Drained when
   * the scroll container becomes available. */
  private pendingObserve = new Set<HTMLElement>();

  // ── Resize observer ──────────────────────────────────────────────────────
  private ro?: ResizeObserver;

  // ── Per-month fetch concurrency cap ─────────────────────────────────────
  // Without a cap, every month inside the IntersectionObserver's rootMargin
  // starts paginating the moment it scrolls into view. A library with 7
  // visible months and one of them at 3000+ photos means dozens of /search
  // requests racing each other and the API server gets hammered. Limit to
  // 2 in flight; queue the rest in the order they were requested.
  private static readonly MAX_CONCURRENT_MONTH_FETCHES = 2;
  private _inflightMonthFetches = 0;
  private _monthFetchQueue: Array<{ year: number; month: number }> = [];

  // ── Viewport-based DOM virtualisation ───────────────────────────────────
  // Rendering 5000+ photo <img> tags up front pegs the browser. Track the
  // set of months whose section is currently intersecting the viewport
  // (with a small margin so adjacent ones come in early), and ONLY render
  // photo <button>s for those months. Off-screen months render a single
  // placeholder div with an estimated height to preserve scroll position.
  private readonly _visibleMonths = signal<Set<string>>(new Set());

  /** rootMargin used by the visibility observer. Tighter than the fetch
   * observer below — we want photo DOM to drop the moment a month leaves
   * the viewport-plus-half-screen, but we want fetch to start a bit
   * earlier so the photos are ready by the time the user scrolls there. */
  private static readonly VISIBLE_ROOT_MARGIN = '300px 0px';
  /** rootMargin used by the fetch observer. Smaller than before (was
   * 600px) so we don't fetch months that are well off-screen. */
  private static readonly FETCH_ROOT_MARGIN = '200px 0px';

  // ── Derived: year-grouped buckets ────────────────────────────────────────
  readonly years = computed<RenderedYear[]>(() => {
    const b = this.buckets();
    if (!b) return [];
    const monthData = this._monthData();
    const grouped: YearGroup[] = [];
    for (const bucket of b.buckets) {
      const last = grouped[grouped.length - 1];
      if (last && last.year === bucket.year) {
        last.count += bucket.count;
        last.months.push(bucket);
      } else {
        grouped.push({ year: bucket.year, count: bucket.count, months: [bucket] });
      }
    }
    const visible = this._visibleMonths();
    const cw = this.containerWidth();
    return grouped.map<RenderedYear>((y) => ({
      year: y.year,
      count: y.count,
      months: y.months.map<RenderedMonth>((bucket) => {
        const data = monthData.get(monthKey(bucket.year, bucket.month)) ?? null;
        // Show partial groups as soon as the first page lands — don't wait
        // for `data.loaded` to flip on the final page. Months with thousands
        // of photos paginate over many round-trips; hiding everything until
        // the last page completes is what made the UI look frozen.
        const groups = data && data.groups.size > 0 ? buildGroups(data) : [];
        const isVisible = visible.has(monthKey(bucket.year, bucket.month));
        return {
          bucket,
          data,
          groups,
          isVisible,
          placeholderHeight: estimateMonthHeight(bucket.count, cw),
        };
      }),
    }));
  });

  // ── Empty-state surface flags ────────────────────────────────────────────
  readonly hasPathPrefix = computed(() => this.timeline.pathPrefix() !== null);
  readonly isEmpty = computed(() => {
    const b = this.buckets();
    return b !== null && b.total === 0;
  });
  readonly untimedHint = computed(() => {
    const b = this.buckets();
    return b !== null && b.untimed_count > 0
      ? `${b.untimed_count} untimed photo${b.untimed_count === 1 ? '' : 's'} hidden — switch to Folder view to see them.`
      : null;
  });

  readonly scrubberBuckets = computed<TimelineBucket[]>(() => this.buckets()?.buckets ?? []);

  constructor() {
    effect(() => {
      const params = this.timeline.params();
      void params;
      this._scheduleBucketsRefresh();
    });

    // Reactive ResizeObserver setup — fires whenever `containerRef`
    // resolves (it's wrapped in nothing conditional, but the signal is
    // populated only after the first render).
    effect(() => {
      const ref = this.containerRef();
      if (!ref || this.ro) return;
      this.ro = new ResizeObserver((entries) => {
        for (const e of entries) this.containerWidth.set(e.contentRect.width);
      });
      this.ro.observe(ref.nativeElement);
      this.containerWidth.set(ref.nativeElement.clientWidth || 800);
    });

    // Reactive IntersectionObserver setup. `scrollContainerRef` may
    // toggle in and out of the DOM as `hasPathPrefix` flips (user
    // de-selects then re-selects a folder), so this effect tracks the
    // current root element and rebuilds the observer whenever the
    // element changes — otherwise the observer ends up rooted at a
    // detached node and never fires intersections.
    effect(() => {
      const ref = this.scrollContainerRef();
      const el = ref?.nativeElement;
      if (!el) {
        this.monthObserver?.disconnect();
        this.visibilityObserver?.disconnect();
        this.monthObserver = undefined;
        this.visibilityObserver = undefined;
        this.observerRoot = undefined;
        this.observedSections = new WeakSet();
        this._visibleMonths.set(new Set());
        return;
      }
      if (this.monthObserver && this.observerRoot === el) return;
      this.monthObserver?.disconnect();
      this.visibilityObserver?.disconnect();
      this.observedSections = new WeakSet();
      this.observerRoot = el;
      // Fetch observer: when a month enters the FETCH_ROOT_MARGIN window,
      // start its /api/search request (subject to the concurrency cap).
      this.monthObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const target = entry.target as HTMLElement;
            const year = Number(target.dataset['year']);
            const month = Number(target.dataset['month']);
            if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
            const key = monthKey(year, month);
            const data = untracked(() => this._monthData().get(key));
            if (!data || data.loaded || data.loading) continue;
            this._patchMonth(key, (d) => ({ ...d, loading: true }));
            this._enqueueMonthFetch(year, month);
          }
        },
        {
          root: el,
          rootMargin: TimelineViewComponent.FETCH_ROOT_MARGIN,
          threshold: 0,
        },
      );
      // Visibility observer: tracks which months are CURRENTLY in (or near)
      // the viewport so the template can virtualise photo DOM. Uses both
      // intersection directions — a month leaving the viewport triggers
      // the photo grid to drop back to a placeholder div.
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
              }
            }
            return next ?? prev;
          });
          // For months that just became visible AND already have data,
          // kick off thumb loads now (the per-month fetch path skipped
          // them earlier because they weren't visible at fetch time).
          if (newlyVisibleKeys.length > 0) {
            const data = untracked(() => this._monthData());
            for (const key of newlyVisibleKeys) {
              const m = data.get(key);
              if (!m || m.groups.size === 0) continue;
              for (const photos of m.groups.values()) {
                for (const p of photos) void this._loadThumb(p);
              }
            }
          }
        },
        {
          root: el,
          rootMargin: TimelineViewComponent.VISIBLE_ROOT_MARGIN,
          threshold: 0,
        },
      );
      // Drain anything that registered before the observers were ready.
      for (const node of this.pendingObserve) {
        this.observedSections.add(node);
        this.monthObserver.observe(node);
        this.visibilityObserver.observe(node);
      }
      this.pendingObserve.clear();
    });
  }

  // Kept on the class so the imports list (and lifecycle declaration) stay
  // honest even though everything moved into reactive effects.
  ngAfterViewInit(): void {}

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.monthObserver?.disconnect();
    this.visibilityObserver?.disconnect();
    if (this.bucketsDebounce !== null) clearTimeout(this.bucketsDebounce);
  }

  /**
   * Called from `[attr.data-month]` rendered nodes via a callback ref.
   * If the observer is already up, observe immediately; otherwise queue
   * for the effect that creates the observer to drain later. Idempotent.
   */
  registerMonthSection = (el: HTMLElement | null): void => {
    if (!el) return;
    if (this.observedSections.has(el)) return;
    this.observedSections.add(el);
    if (this.monthObserver && this.visibilityObserver) {
      this.monthObserver.observe(el);
      this.visibilityObserver.observe(el);
    } else {
      this.pendingObserve.add(el);
    }
  };

  // ── Buckets request ──────────────────────────────────────────────────────
  private _scheduleBucketsRefresh(): void {
    if (this.bucketsDebounce !== null) clearTimeout(this.bucketsDebounce);
    this.bucketsDebounce = setTimeout(() => {
      void this._runBucketsRefresh();
    }, 250);
  }

  private async _runBucketsRefresh(): Promise<void> {
    const params = this.timeline.params();
    if (!params) {
      // No scope selected. Don't nuke `buckets` here — the `hasPathPrefix()`
      // empty-state branch in the template handles the no-scope view, and
      // keeping the previous buckets around means a brief null transition
      // between two valid scopes doesn't flash the loading state.
      return;
    }
    const gen = ++this.bucketsGen;
    this.bucketsLoading.set(true);
    this.bucketsError.set(null);
    try {
      const r = await firstValueFrom(this.search.buckets(params));
      if (gen !== this.bucketsGen) return;
      this.buckets.set(r);
      const next = new Map<string, MonthData>();
      for (const b of r.buckets) {
        next.set(monthKey(b.year, b.month), {
          bucket: b,
          loaded: false,
          loading: false,
          error: null,
          groups: new Map(),
        });
      }
      this._monthData.set(next);
    } catch (err) {
      if (gen !== this.bucketsGen) return;
      this.bucketsError.set(errorMessage(err));
      this.buckets.set(null);
    } finally {
      if (gen === this.bucketsGen) this.bucketsLoading.set(false);
    }
  }

  // ── Per-month fetch ──────────────────────────────────────────────────────
  // Pages through every photo in the month so a 1000-photo month renders
  // completely (not just the first 200). Each page merges into the existing
  // groups, the panel paints between pages, and the generation guard short-
  // circuits the loop when the user scrolls away or filters change.
  private async _fetchMonth(year: number, month: number): Promise<void> {
    const key = monthKey(year, month);
    const params = untracked(() => this.timeline.params());
    const prefix = untracked(() => this.timeline.pathPrefix());
    if (!params || !prefix) {
      this._patchMonth(key, (d) => ({ ...d, loading: false }));
      return;
    }
    const gen = (this.monthGens.get(key) ?? 0) + 1;
    this.monthGens.set(key, gen);

    const fromDate = `${pad4(year)}-${pad2(month)}-01`;
    const toDate = `${pad4(year)}-${pad2(month)}-${pad2(daysInMonth(year, month))}`;
    const baseReq: Omit<SearchParams, 'page'> = {
      ...params,
      from: fromDate,
      to: toDate,
      sort: 'captured_desc',
      limit: PAGE_SIZE,
    };

    let page = 0;
    let loaded = 0;
    let total = Infinity;

    try {
      while (loaded < total) {
        const r = await firstValueFrom(this.search.search({ ...baseReq, page }));
        if (gen !== this.monthGens.get(key)) return;
        total = r.total;
        const pageGroups = this._bucketByFolder(r.results, prefix);
        loaded += r.results.length;
        const isFinal = loaded >= total || r.results.length === 0;
        // Merge the new page's groups into whatever the month already
        // has in `_monthData`, NOT into a local var. Earlier versions
        // kept a `merged` local that got snapshot-patched in here on
        // every page — but that snapshot was taken before `_loadThumb`
        // had a chance to update PhotoVm.thumbUrl on previous pages, so
        // each subsequent patch wiped the thumbnails of every prior
        // page. Rebuilding from `_monthData.groups` preserves any
        // in-flight thumb updates.
        this._patchMonth(key, (d) => {
          const next = new Map(d.groups);
          for (const [name, photos] of pageGroups) {
            const existing = next.get(name);
            next.set(name, existing ? [...existing, ...photos] : photos);
          }
          return {
            ...d,
            loaded: isFinal,
            loading: !isFinal,
            error: null,
            groups: next,
          };
        });
        // Only pre-load thumbs if this month is currently visible. Off-
        // screen months get their thumbs loaded later when the visibility
        // observer flips them visible — otherwise a fully-fetched but
        // off-screen month with 80 photos would fire 80 thumb requests
        // for nothing (see _visibleMonths effect).
        if (untracked(() => this._visibleMonths().has(key))) {
          for (const photos of pageGroups.values()) {
            for (const p of photos) void this._loadThumb(p);
          }
        }
        if (r.results.length === 0) break;
        page += 1;
      }
    } catch (err) {
      if (gen !== this.monthGens.get(key)) return;
      // Mark the month as a loading-failed terminal state so the template
      // can surface the error instead of staying on "Loading…" forever.
      const message = errorMessage(err);
      this._patchMonth(key, (d) => ({
        ...d,
        loaded: true,
        loading: false,
        error: message || 'Failed to load this month',
      }));
    }
  }

  /** Re-fetches a specific month after an error. Bumps the generation
   * counter so any in-flight retry from a stale click is dropped. */
  retryMonth(year: number, month: number): void {
    const key = monthKey(year, month);
    this._patchMonth(key, (d) => ({ ...d, loaded: false, loading: true, error: null }));
    this._enqueueMonthFetch(year, month);
  }

  /** Submit a month for fetching, respecting MAX_CONCURRENT_MONTH_FETCHES.
   * If the cap is hit the request waits in FIFO order; the next slot frees
   * when an in-flight `_fetchMonth` resolves. */
  private _enqueueMonthFetch(year: number, month: number): void {
    if (this._inflightMonthFetches >= TimelineViewComponent.MAX_CONCURRENT_MONTH_FETCHES) {
      this._monthFetchQueue.push({ year, month });
      return;
    }
    this._inflightMonthFetches += 1;
    void this._fetchMonth(year, month).finally(() => {
      this._inflightMonthFetches -= 1;
      const next = this._monthFetchQueue.shift();
      if (next) this._enqueueMonthFetch(next.year, next.month);
    });
  }

  private _bucketByFolder(results: SearchResult[], prefix: string): Map<string, PhotoVm[]> {
    const groups = new Map<string, PhotoVm[]>();
    for (const r of results) {
      const rest = r.abs_path.startsWith(prefix) ? r.abs_path.slice(prefix.length) : r.abs_path;
      const segments = rest.split('/').filter((s) => s.length > 0);
      // First segment is the folder; if there's only the filename, bucket
      // under '.' to render as "(this folder)".
      const folderName = segments.length > 1 ? segments[0]! : '.';
      const cached = this.thumbCache.get(r.abs_path) ?? null;
      const vm: PhotoVm = { ...r, thumbUrl: cached };
      const arr = groups.get(folderName);
      if (arr) arr.push(vm);
      else groups.set(folderName, [vm]);
    }
    return groups;
  }

  private _patchMonth(key: string, patcher: (d: MonthData) => MonthData): void {
    this._monthData.update((map) => {
      const cur = map.get(key);
      if (!cur) return map;
      const next = new Map(map);
      next.set(key, patcher(cur));
      return next;
    });
  }

  // ── Thumbnail loading ────────────────────────────────────────────────────
  private async _loadThumb(p: PhotoVm): Promise<void> {
    if (p.thumbUrl) return;
    if (this.thumbCache.has(p.abs_path)) return;
    try {
      const url = await this.fsBrowse.getThumbBlobUrl(p.abs_path, 512);
      this.thumbCache.set(p.abs_path, url);
      this._monthData.update((map) => {
        const next = new Map(map);
        for (const [k, v] of next) {
          let changed = false;
          const newGroups = new Map<string, PhotoVm[]>();
          for (const [g, photos] of v.groups) {
            const idx = photos.findIndex((x) => x.abs_path === p.abs_path);
            if (idx === -1) {
              newGroups.set(g, photos);
              continue;
            }
            const updated = photos.slice();
            updated[idx] = { ...updated[idx]!, thumbUrl: url };
            newGroups.set(g, updated);
            changed = true;
          }
          if (changed) next.set(k, { ...v, groups: newGroups });
        }
        return next;
      });
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

  // ── Scrubber jump ────────────────────────────────────────────────────────
  onScrubberJump(target: { year: number; month: number }): void {
    const root = this.scrollContainerRef()?.nativeElement;
    if (!root) return;
    const el = root.querySelector(
      `[data-year="${target.year}"][data-month="${target.month}"]`,
    ) as HTMLElement | null;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Template helpers ─────────────────────────────────────────────────────
  monthLabel = (m: number): string => MONTH_NAMES[m - 1] ?? String(m);
  folderGroupLabel = (name: string): string => (name === '.' ? '(this folder)' : name);

  trackYear = (_: number, y: RenderedYear): number => y.year;
  trackMonth = (_: number, m: RenderedMonth): string => `${m.bucket.year}-${m.bucket.month}`;
  trackGroup = (_: number, g: { folderName: string; photos: PhotoVm[] }): string => g.folderName;
  trackPhoto = (_: number, p: PhotoVm): string => p.id;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function monthKey(year: number, month: number): string {
  return `${year}-${month}`;
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month: number): number {
  // Use UTC: EXIF capture-at is stored as UTC, and constructing in local time
  // can drift by a day at month boundaries when the user is east of UTC.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function maxTime(photos: PhotoVm[]): number {
  let max = 0;
  for (const p of photos) {
    if (!p.captured_at) continue;
    const t = Date.parse(p.captured_at);
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return max;
}

function buildGroups(data: MonthData): Array<{ folderName: string; photos: PhotoVm[] }> {
  const names = Array.from(data.groups.keys());
  names.sort((a, b) => maxTime(data.groups.get(b)!) - maxTime(data.groups.get(a)!));
  return names.map((folderName) => ({
    folderName,
    photos: data.groups.get(folderName)!,
  }));
}

/** Estimate the rendered height of a month's photo grid for the placeholder
 * shown when the section is off-screen. Photos are 140 px tall in a flex-wrap
 * container with a 4 px gap; assume one folder-group header per ~60 photos to
 * approximate the typical vertical contribution. Worst case the estimate is
 * off and the scrollbar drifts a bit on first paint — that's preferable to
 * mounting thousands of <img> tags. */
function estimateMonthHeight(count: number, containerWidth: number): number {
  if (count <= 0) return 36;
  const cellSize = 144; // 140 px photo + 4 px gap
  const usable = Math.max(160, containerWidth - 32); // -px for padding + scrubber
  const perRow = Math.max(1, Math.floor(usable / cellSize));
  const rows = Math.ceil(count / perRow);
  const groupHeaders = Math.max(1, Math.ceil(count / 60)) * 24;
  return rows * cellSize + groupHeaders + 32;
}
