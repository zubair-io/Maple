// HiddenPeopleComponent — `/settings/people/hidden` (auth + owner-gated).
//
// The Hidden page: lists soft-hidden people (those an operator hid from the
// main People list) and lets them be restored. Hidden persons keep their
// faces grouped server-side and stay clustering seeds, so restoring one
// brings back a fully-populated cluster rather than an empty shell.
//
// Reuses the People list presentation: the same card grid, the same
// CDK virtual-scroll row-packing (people can be many), the same
// bbox-cropped cover thumbs via {@link ThumbBlobCache}, and the same pure
// view-model helpers in `people.vm.ts`. Only the data source (the store's
// hidden-list SWR cache) and the per-card action ("Restore" instead of
// "Hide") differ.
//
// State source of truth is the store's hidden-list SWR cache: cached rows
// render instantly on re-entry while a background refresh validates.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { RouterLink } from '@angular/router';
import {
  ApiPerson,
  Bbox,
  BunApiBackendService,
  FilesystemBrowseService,
  PeopleStore,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import { MapleVisibleOnceDirective } from './visible-once.directive';
import { ThumbBlobCache } from './thumb-blob-cache';
import {
  Toast,
  Tone,
  TOAST_TTL_MS,
  NaturalDims,
  PEOPLE_GRID,
  chunkPeopleRows,
  errorMessage,
  faceCropTransform,
  isAutoNamed,
  peopleCardWidth,
  peopleGridColumns,
  peopleRowHeight,
  peopleRowKey,
  sortPeople,
  withNaturalDims,
} from './people.vm';

@Component({
  standalone: true,
  selector: 'maple-hidden-people',
  imports: [
    DecimalPipe,
    RouterLink,
    ScrollingModule,
    SettingsShellComponent,
    SettingsIconComponent,
    MapleVisibleOnceDirective,
  ],
  templateUrl: './hidden-people.component.html',
  styleUrl: './people.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HiddenPeopleComponent implements OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly store = inject(PeopleStore);

  /** Hidden people, fed by the store's hidden-list SWR cache. `?? []` so the
   * template's `@for` sees an array before the first fetch resolves. */
  readonly people = computed<ApiPerson[]>(() => this.store.hidden() ?? []);

  readonly loadError = computed<string | null>(() => {
    const err = this.store.hiddenError();
    return err ? errorMessage(err) : null;
  });

  readonly hasPeople = computed(() => this.people().length > 0);

  /** First fetch in flight (nothing cached to show yet). */
  readonly loading = computed(() => this.store.hiddenLoading());

  readonly sortedPeople = computed(() => sortPeople(this.people()));

  readonly toast = signal<Toast | null>(null);

  /** Restore in flight, keyed by person id, so a card can show "Restoring…"
   * and disable its button without blocking the rest of the grid. */
  readonly restoringIds = signal<ReadonlySet<string>>(new Set());

  protected readonly isAutoName = isAutoNamed;

  // ── Virtual-scroll grid (mirrors PeopleComponent) ──────────────────────────

  private readonly peopleScrollContent = viewChild<ElementRef<HTMLElement>>('peopleScrollContent');
  private readonly containerWidth = signal<number>(900);
  private readonly minCardWidth = computed(() => (this.containerWidth() <= 767 ? 140 : 180));

  readonly gridColumns = computed(() =>
    peopleGridColumns(this.containerWidth(), this.minCardWidth()),
  );
  readonly cardWidth = computed(() => peopleCardWidth(this.containerWidth(), this.gridColumns()));
  readonly rowHeight = computed(() => peopleRowHeight(this.cardWidth()));
  protected readonly gridGap = PEOPLE_GRID.GAP;
  readonly peopleRows = computed(() => chunkPeopleRows(this.sortedPeople(), this.gridColumns()));
  trackRow = peopleRowKey;

  protected readonly imgNaturalDims = signal<ReadonlyMap<string, NaturalDims>>(new Map());

  private readonly thumbs = new ThumbBlobCache(this.api, this.fsBrowse);

  constructor() {
    // SWR hidden list: first entry fetches, later entries serve cached + refresh.
    this.store.ensureHidden();

    // Re-target the ResizeObserver each time the viewport appears (it lives in
    // a conditional block, like the main People list).
    effect((onCleanup) => {
      // Guard `nativeElement` too, not just the ref: after the @if swap
      // between the empty state and the populated grid, the signal query
      // can briefly hold a stale ElementRef whose nativeElement is
      // undefined, and observeViewport would crash on `host.clientWidth`
      // every change-detection pass (mirrors the PeopleComponent fix, #2081).
      const host = this.peopleScrollContent()?.nativeElement;
      if (!host) return;
      this.observeViewport(host);
      onCleanup(() => this.resizeObserver?.disconnect());
    });
  }

  private resizeObserver?: ResizeObserver;

  private observeViewport(host: HTMLElement): void {
    this.containerWidth.set(host.clientWidth || 900);
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) this.containerWidth.set(e.contentRect.width);
    });
    this.resizeObserver.observe(host);
  }

  ngOnDestroy(): void {
    this.thumbs.destroy();
    this.resizeObserver?.disconnect();
  }

  // ── Cover thumbs (reused from People) ──────────────────────────────────────

  ensureCoverThumb(p: ApiPerson): void {
    const key = ThumbBlobCache.coverKey(p);
    if (key) this.thumbs.ensure(key, p.coverAddress ?? null, p.coverAbsPath, p.coverAssetId);
  }

  coverThumbUrl(person: ApiPerson): string | null {
    return this.thumbs.url(ThumbBlobCache.coverKey(person));
  }

  onFaceImgLoad(url: string, event: Event): void {
    const img = event.target as HTMLImageElement;
    this.imgNaturalDims.set(
      withNaturalDims(this.imgNaturalDims(), url, img.naturalWidth, img.naturalHeight),
    );
  }

  faceCropTransform(bbox: Bbox, url: string | null): string {
    const dims = url ? (this.imgNaturalDims().get(url) ?? null) : null;
    return faceCropTransform(bbox, dims);
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  isRestoring(id: string): boolean {
    return this.restoringIds().has(id);
  }

  /** Restore a hidden person — clears the flag server-side and refreshes both
   * lists so the person leaves the Hidden page and returns to People. */
  async restore(person: ApiPerson): Promise<void> {
    if (this.isRestoring(person.id)) return;
    this.restoringIds.update((s) => new Set(s).add(person.id));
    try {
      await this.store.unhidePerson(person.id);
      this.showToast(`Restored ${person.name}`, 'success');
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    } finally {
      this.restoringIds.update((s) => {
        const next = new Set(s);
        next.delete(person.id);
        return next;
      });
    }
  }

  private showToast(text: string, tone: Tone): void {
    this.toast.set({ text, tone });
    setTimeout(() => {
      const cur = this.toast();
      if (cur && cur.text === text) this.toast.set(null);
    }, TOAST_TTL_MS);
  }
}
