// PeopleGridLayout + toast helper — the virtual-scroll grid plumbing shared
// by PeopleComponent and RestorablePeopleComponent, extracted in the #2897
// review round (fallow flagged the copies once hidden-people.component was
// generalized into restorable-people.component).
//
// The layout owns the measured container width, the derived column/card/row
// geometry, and the ResizeObserver lifecycle. Components keep their own
// row-packing computed (they chunk different source lists) and template
// aliases.

import {
  Directive,
  computed,
  effect,
  inject,
  signal,
  type ElementRef,
  type OnDestroy,
  type Signal,
} from '@angular/core';
import {
  type ApiPerson,
  BunApiBackendService,
  FilesystemBrowseService,
  LIBRARY_SOURCE,
} from '@maple-common';
import { ThumbBlobCache } from './thumb-blob-cache';
import {
  PEOPLE_GRID,
  Toast,
  Tone,
  TOAST_TTL_MS,
  peopleCardWidth,
  peopleGridColumns,
  peopleRowHeight,
} from './people.vm';

class PeopleGridLayout {
  /** Measured inner width of the viewport. Seeded until the ResizeObserver
   * reports the real width. */
  private readonly containerWidth = signal<number>(900);

  /** Min card width — denser on narrow (phone) viewports, matching the old
   * responsive `minmax(140px|180px, 1fr)` CSS. */
  private readonly minCardWidth = computed(() => (this.containerWidth() <= 767 ? 140 : 180));

  readonly gridColumns = computed(() =>
    peopleGridColumns(this.containerWidth(), this.minCardWidth()),
  );

  /** Square card side (px) for the current column count + container width. */
  readonly cardWidth = computed(() => peopleCardWidth(this.containerWidth(), this.gridColumns()));

  /** Fixed row height fed to the viewport `itemSize`. */
  readonly rowHeight = computed(() => peopleRowHeight(this.cardWidth()));

  /** Inter-card gap + per-row bottom margin (px). One source of truth shared
   * with the packing math (`peopleRowHeight` adds one `GAP`/row). */
  readonly gridGap = PEOPLE_GRID.GAP;

  /** ResizeObserver on the viewport content so the column count + card/row
   * sizes track the container width. Re-targeted by `bindViewport`. */
  private resizeObserver?: ResizeObserver;

  /** (Re)attach the ResizeObserver to the current viewport host and seed the
   * width immediately. Disconnects any prior observer first. */
  observeViewport(host: HTMLElement): void {
    this.containerWidth.set(host.clientWidth || 900);
    if (typeof ResizeObserver === 'undefined') return; // SSR / very old browser
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const e of entries) this.containerWidth.set(e.contentRect.width);
    });
    this.resizeObserver.observe(host);
  }

  disconnect(): void {
    this.resizeObserver?.disconnect();
  }
}

/**
 * Re-target the layout's ResizeObserver each time the virtual-scroll
 * viewport appears. It lives in conditional template blocks (only the
 * populated list view renders it), so a signal-query effect catches first
 * paint and back-navigation alike. `onCleanup` disconnects when the
 * viewport leaves the DOM so a detached element isn't observed/retained
 * until destroy; the effect re-attaches when the query resolves to a fresh
 * element again. Call from a constructor (needs an injection context).
 *
 * Guards `nativeElement` too, not just the ref: after an @if swap the
 * signal query can briefly hold a stale ElementRef whose nativeElement is
 * undefined, and observeViewport would crash on `host.clientWidth` (#2080).
 */
export function bindGridViewport(
  layout: PeopleGridLayout,
  hostRef: Signal<ElementRef<HTMLElement> | undefined>,
): void {
  effect((onCleanup) => {
    const host = hostRef()?.nativeElement;
    if (!host) return;
    layout.observeViewport(host);
    onCleanup(() => layout.disconnect());
  });
}

/** Toast signal + auto-dismiss show(), shared by both people pages. Each
 * show() restarts the dismiss timer, so back-to-back toasts (even with
 * identical text) always get the full TTL (#2897 review). */
export function createToast(): {
  toast: Signal<Toast | null>;
  show(text: string, tone: Tone): void;
} {
  const toast = signal<Toast | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    toast,
    show(text: string, tone: Tone): void {
      clearTimeout(timer);
      toast.set({ text, tone });
      timer = setTimeout(() => toast.set(null), TOAST_TTL_MS);
    },
  };
}

/**
 * Shared host for the two people pages (PeopleComponent +
 * RestorablePeopleComponent): grid layout, the cover-thumb cache, and their
 * teardown. Subclasses add their own data source, row packing, and actions.
 *
 * `LIBRARY_SOURCE` is injected optionally so the base has no hard
 * dependency on the M2 addressing provider; where it exists (both pages in
 * the shipped app) covers resolve through the immutable-cached
 * `/api/thumb/:address` path, cache-coherent with /browse.
 */
// eslint-disable-next-line @angular-eslint/directive-class-suffix -- DI-using base class, standard Angular pattern
@Directive()
export abstract class PeopleGridHost implements OnDestroy {
  protected readonly api = inject(BunApiBackendService);
  protected readonly fsBrowse = inject(FilesystemBrowseService);
  protected readonly librarySource = inject(LIBRARY_SOURCE, { optional: true });

  /** Shared grid geometry + ResizeObserver lifecycle. */
  protected readonly layout = new PeopleGridLayout();
  readonly gridColumns = this.layout.gridColumns;
  readonly cardWidth = this.layout.cardWidth;
  readonly rowHeight = this.layout.rowHeight;
  protected readonly gridGap = this.layout.gridGap;

  protected readonly thumbs = new ThumbBlobCache(
    this.api,
    this.fsBrowse,
    this.librarySource ?? undefined,
  );

  ensureCoverThumb(p: ApiPerson): void {
    this.thumbs.ensureCover(p);
  }

  coverThumbUrl(person: ApiPerson): string | null {
    return this.thumbs.coverUrl(person);
  }

  ngOnDestroy(): void {
    this.thumbs.destroy();
    this.layout.disconnect();
  }
}
