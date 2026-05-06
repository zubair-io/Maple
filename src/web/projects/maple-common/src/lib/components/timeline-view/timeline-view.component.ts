// TimelineView — Year → Month → folder grouped scroller.
//
// Data flow (matching docs/superpowers/specs/2026-05-06-timeline-view-design.md):
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
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
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

interface PhotoVm extends SearchResult {
  thumbUrl: string | null;
}

interface MonthData {
  bucket: TimelineBucket;
  loaded: boolean;
  loading: boolean;
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
  @ViewChild('scrollContainer', { read: ElementRef })
  scrollContainerRef?: ElementRef<HTMLElement>;
  @ViewChild('container', { read: ElementRef })
  containerRef?: ElementRef<HTMLElement>;

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

  // ── IntersectionObserver for lazy-loaded months ──────────────────────────
  private monthObserver?: IntersectionObserver;
  private observedSections = new WeakSet<HTMLElement>();

  // ── Resize observer ──────────────────────────────────────────────────────
  private ro?: ResizeObserver;

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
    return grouped.map<RenderedYear>((y) => ({
      year: y.year,
      count: y.count,
      months: y.months.map<RenderedMonth>((bucket) => {
        const data = monthData.get(monthKey(bucket.year, bucket.month)) ?? null;
        const groups = data && data.loaded ? buildGroups(data) : [];
        return { bucket, data, groups };
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
  }

  ngAfterViewInit(): void {
    if (this.containerRef) {
      this.ro = new ResizeObserver((entries) => {
        for (const e of entries) this.containerWidth.set(e.contentRect.width);
      });
      this.ro.observe(this.containerRef.nativeElement);
      this.containerWidth.set(this.containerRef.nativeElement.clientWidth || 800);
    }
    if (this.scrollContainerRef) {
      this.monthObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target as HTMLElement;
            const year = Number(el.dataset['year']);
            const month = Number(el.dataset['month']);
            if (!Number.isFinite(year) || !Number.isFinite(month)) continue;
            const key = monthKey(year, month);
            const data = this._monthData().get(key);
            if (!data || data.loaded || data.loading) continue;
            this._patchMonth(key, (d) => ({ ...d, loading: true }));
            void this._fetchMonth(year, month);
          }
        },
        {
          root: this.scrollContainerRef.nativeElement,
          rootMargin: '600px 0px',
          threshold: 0,
        },
      );
    }
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
    this.monthObserver?.disconnect();
    if (this.bucketsDebounce !== null) clearTimeout(this.bucketsDebounce);
  }

  /**
   * Called from `[attr.data-month]` rendered nodes via a callback ref. Hooks
   * each month section into the IntersectionObserver so we know when to
   * fetch its photos.
   */
  registerMonthSection = (el: HTMLElement | null): void => {
    if (!el || !this.monthObserver) return;
    if (this.observedSections.has(el)) return;
    this.observedSections.add(el);
    this.monthObserver.observe(el);
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
      this.buckets.set(null);
      this._monthData.set(new Map());
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
          groups: new Map(),
        });
      }
      this._monthData.set(next);
    } catch (err) {
      if (gen !== this.bucketsGen) return;
      this.bucketsError.set(err instanceof Error ? err.message : String(err));
      this.buckets.set(null);
    } finally {
      if (gen === this.bucketsGen) this.bucketsLoading.set(false);
    }
  }

  // ── Per-month fetch ──────────────────────────────────────────────────────
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
    const req: SearchParams = {
      ...params,
      from: fromDate,
      to: toDate,
      sort: 'captured_desc',
      page: 0,
      limit: PAGE_SIZE,
    };
    try {
      const r = await firstValueFrom(this.search.search(req));
      if (gen !== this.monthGens.get(key)) return;
      const groups = this._bucketByFolder(r.results, prefix);
      this._patchMonth(key, (d) => ({
        ...d,
        loaded: true,
        loading: false,
        groups,
      }));
      for (const photos of groups.values()) {
        for (const p of photos) void this._loadThumb(p);
      }
    } catch {
      if (gen !== this.monthGens.get(key)) return;
      this._patchMonth(key, (d) => ({ ...d, loading: false }));
    }
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

  // ── Click handlers ───────────────────────────────────────────────────────
  onPhotoClick(p: PhotoVm, e: MouseEvent): void {
    this.state.selectAsset(p.id, e.metaKey || e.ctrlKey, e.shiftKey);
  }

  onPhotoDblClick(p: PhotoVm): void {
    this.state.selectAsset(p.id);
    void this.router.navigate(['/edit', p.id]);
  }

  // ── Scrubber jump ────────────────────────────────────────────────────────
  onScrubberJump(target: { year: number; month: number }): void {
    const root = this.scrollContainerRef?.nativeElement;
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
  return new Date(year, month, 0).getDate();
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
