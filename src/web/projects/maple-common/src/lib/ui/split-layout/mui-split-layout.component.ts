// MuiSplitLayout — Maple UI Templates (unified-component-catalog.md §5).
// Three-region layout: Sidebar, Center, Detail. Backs the Browse, Editor,
// Document, and Chat pages (§6). Regions only — no content of its own.
//
// Sidebar and Detail are draggable-resizable (pointer-capture drag on a
// handle between regions, same "pointerdown hit-test → setPointerCapture →
// pointermove/pointerup on the same element" contract as mui-drag-bar/
// mui-color-wheel/mui-pad-2d — see ../internal/pointer-drag.ts) and clamp to
// their min/max width inputs. `sidebarWidth`/`detailWidth` are `model()`s so
// a drag's result is directly two-way bindable by the caller.
//
// Collapse order at narrow widths: Detail collapses first (it's the most
// dispensable region — an inspector or thread panel), then Sidebar, leaving
// Center full-width on a phone. Width comes from a `ResizeObserver` on the
// host (the "host-width via ResizeObserver signal" option named in the W5
// brief) rather than a CSS container query, because the collapse also has
// to gate which regions render draggable handles at all.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  input,
  model,
  signal,
} from '@angular/core';
import { isPointerDragEnd, isPointerDragMove } from '../internal/pointer-drag';

/** Below this host width, Detail collapses (hidden) even if `showDetail` is
 * true — there's no room for a third column. */
const DETAIL_COLLAPSE_PX = 900;
/** Below this host width, Sidebar collapses too, leaving Center alone. */
const SIDEBAR_COLLAPSE_PX = 640;

@Component({
  selector: 'mui-split-layout',
  standalone: true,
  templateUrl: './mui-split-layout.component.html',
  host: { class: 'block h-full min-h-0' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSplitLayoutComponent implements OnDestroy {
  readonly sidebarWidth = model<number>(260);
  readonly sidebarMin = input<number>(200);
  readonly sidebarMax = input<number>(400);

  /** Whether the Detail region is in use at all — a caller with nothing to
   * put there (e.g. Chat with no thread open) sets this false rather than
   * projecting an empty region. */
  readonly showDetail = input<boolean>(true);
  readonly detailWidth = model<number>(320);
  readonly detailMin = input<number>(240);
  readonly detailMax = input<number>(480);

  /** Set false to keep every region rendered regardless of host width — an
   * escape hatch for embedding a miniature/preview instance (e.g. a design
   * showcase card) narrower than the collapse breakpoints without it
   * losing regions. */
  readonly collapseEnabled = input<boolean>(true);

  private readonly host = inject(ElementRef<HTMLElement>);
  private ro?: ResizeObserver;

  /** Defaults wide (no collapse) until the first ResizeObserver callback
   * lands — avoids a flash-collapse before the host has ever been
   * measured, and keeps this component's collapse behavior inert in
   * environments (like jsdom without a ResizeObserver stub) that never
   * fire a callback at all. */
  protected readonly hostWidth = signal<number>(Number.POSITIVE_INFINITY);

  protected readonly detailCollapsed = computed(
    () => !this.showDetail() || (this.collapseEnabled() && this.hostWidth() < DETAIL_COLLAPSE_PX),
  );
  protected readonly sidebarCollapsed = computed(
    () => this.collapseEnabled() && this.hostWidth() < SIDEBAR_COLLAPSE_PX,
  );

  private sidebarDragPointerId: number | null = null;
  private sidebarDragStartX = 0;
  private sidebarDragStartWidth = 0;

  private detailDragPointerId: number | null = null;
  private detailDragStartX = 0;
  private detailDragStartWidth = 0;

  constructor() {
    // Angular's ResizeObserver typing is fine in a browser build; jsdom
    // (unit tests) has no global ResizeObserver at all unless a spec stubs
    // one in, so guard the construction the same way image-canvas.component
    // does.
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver((entries) => {
        for (const entry of entries) this.hostWidth.set(entry.contentRect.width);
      });
      this.ro.observe(this.host.nativeElement);
    }
  }

  ngOnDestroy(): void {
    this.ro?.disconnect();
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  onSidebarHandlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.sidebarDragPointerId = event.pointerId;
    this.sidebarDragStartX = event.clientX;
    this.sidebarDragStartWidth = this.sidebarWidth();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  onSidebarHandlePointerMove(event: PointerEvent): void {
    if (!isPointerDragMove(this.sidebarDragPointerId !== null, event, this.sidebarDragPointerId))
      return;
    const dx = event.clientX - this.sidebarDragStartX;
    this.sidebarWidth.set(
      this.clamp(this.sidebarDragStartWidth + dx, this.sidebarMin(), this.sidebarMax()),
    );
  }

  onSidebarHandlePointerUp(event: PointerEvent): void {
    if (!isPointerDragEnd(event, this.sidebarDragPointerId)) return;
    this.sidebarDragPointerId = null;
  }

  onDetailHandlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.detailDragPointerId = event.pointerId;
    this.detailDragStartX = event.clientX;
    this.detailDragStartWidth = this.detailWidth();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  onDetailHandlePointerMove(event: PointerEvent): void {
    if (!isPointerDragMove(this.detailDragPointerId !== null, event, this.detailDragPointerId))
      return;
    // Detail sits to the right of its handle, so dragging left (negative
    // dx) grows it — invert the delta relative to the Sidebar handle.
    const dx = event.clientX - this.detailDragStartX;
    this.detailWidth.set(
      this.clamp(this.detailDragStartWidth - dx, this.detailMin(), this.detailMax()),
    );
  }

  onDetailHandlePointerUp(event: PointerEvent): void {
    if (!isPointerDragEnd(event, this.detailDragPointerId)) return;
    this.detailDragPointerId = null;
  }
}
