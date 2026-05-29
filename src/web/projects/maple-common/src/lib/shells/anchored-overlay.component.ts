// AnchoredOverlayComponent — tablet/desktop anchored-overlay primitive (S7
// follow-up, #645).
//
// Spec: docs/design/responsive-program/s7-search.md §2 "Tablet" / "Desktop".
//
// Phone search ships as a full-page surface (S7 / #629). Tablet and desktop
// present `<app-search>` as an overlay anchored just below the source-picker
// sidebar's search pill — 320pt wide on tablet, 480pt on desktop — with a
// backdrop scrim that dims the main pane (25%) and, on desktop, the
// inspector column (35%). The sidebar itself stays bright behind the scrim
// so the pill remains visible while the overlay is open.
//
// Why a fresh component (not BottomSheet): the bottom-sheet primitive is
// shaped around a phone full-width sheet that sticks to the viewport
// bottom, owns a 38×4 grab handle and a pan-down dismiss gesture, and runs
// a single full-viewport 35% scrim. The overlay is anchored positioning,
// per-region scrims, scale-from-anchor transition, and focus-trap — almost
// no surface overlaps. Audit confirmed extending BottomSheet would mean
// gutting most of it; clean primitive lives here instead.
//
// Surface:
//   - `anchor` — required ElementRef or HTMLElement the overlay attaches
//     below/left-aligned to. Position is recomputed on every open and on
//     viewport resize.
//   - `widthPx` — overlay column width (default 320 / tablet). Pass 480
//     for desktop. The host owns the breakpoint switch.
//   - `scrimOpacity` — opacity of the main-pane scrim (default 0.25). Set
//     to 0 to suppress (e.g. in unit tests / Storybook hosts).
//   - `inspectorAnchor` — optional ElementRef of an inspector column that
//     wants its own scrim at `inspectorScrimOpacity` (default 0.35 per
//     desktop spec). Omit on tablet — there's no inspector column there.
//   - `isOpen` — two-way model the host owns. Esc + outside-click flip it
//     to false; `isOpenChange` is the modern Angular event signal name
//     consumers wire up with `[(isOpen)]`.
//
// Behaviours: outside-click dismiss (anywhere except the overlay's own
// bounds), Esc dismiss, focus the first focusable on open + restore focus
// to the anchor on close, Tab cycle inside the overlay while open.
//
// Motion token: `MapleMotion.sheetPresent` (320ms, snappy ease). The CSS
// uses the existing `--motion-sheet-present-*` custom properties.
//
// Wiring for S7: the host (browse-shell tablet/desktop sidebar) renders
// `<app-anchored-overlay>` wrapping `<app-search>` once #629 merges. This
// PR ships the primitive plus a placeholder host that mounts a stub —
// flipping to the real `<app-search>` is a one-line template change.

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  effect,
  input,
  model,
  signal,
} from '@angular/core';

/** Overlay padding below the anchor — keeps the top of the overlay
 * visually separated from the pill bottom edge. Matches the 4pt the
 * source-picker drawer uses below its own pill. */
const ANCHOR_GAP_PX = 4;

@Component({
  selector: 'app-anchored-overlay',
  standalone: true,
  templateUrl: './anchored-overlay.component.html',
  styleUrl: './anchored-overlay.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnchoredOverlayComponent implements AfterViewInit {
  /** Anchor element the overlay positions itself against. Required — the
   * primitive has nothing meaningful to do without one. Accepts either an
   * `ElementRef` (the common Angular case) or a raw HTMLElement (handy
   * when the host has a `viewChild()` signal returning HTMLElement). */
  readonly anchor = input.required<ElementRef<HTMLElement> | HTMLElement>();

  /** Overlay column width in CSS pixels. 320 = tablet, 480 = desktop. */
  readonly widthPx = input<number>(320);

  /** Main-pane scrim opacity (0..1). Spec: 25% on tablet + desktop main. */
  readonly scrimOpacity = input<number>(0.25);

  /** Optional inspector column to dim with a separate scrim (desktop only). */
  readonly inspectorAnchor = input<ElementRef<HTMLElement> | HTMLElement | null>(null);

  /** Inspector scrim opacity (0..1). Spec: 35% on desktop inspector. */
  readonly inspectorScrimOpacity = input<number>(0.35);

  /** Two-way: parent owns whether the overlay is presented. */
  readonly isOpen = model<boolean>(false);

  /** Live anchor rect — recomputed on open and on resize. */
  protected readonly anchorRect = signal<DOMRect | null>(null);
  protected readonly inspectorRect = signal<DOMRect | null>(null);

  /** Top-left position of the overlay panel, in viewport-fixed coordinates. */
  protected readonly overlayPosition = computed(() => {
    const rect = this.anchorRect();
    if (!rect) return { top: 0, left: 0 };
    return {
      top: rect.bottom + ANCHOR_GAP_PX,
      left: rect.left,
    };
  });

  /** Main scrim spans the viewport minus the anchor's container column.
   * The container is the anchor's nearest non-overlay ancestor — we
   * approximate it as the anchor's parent element's bounding rect, which
   * matches the sidebar column for the source-picker pill placement.
   * Falls back to "right of the anchor" when no parent rect is available
   * (e.g. anchor mounted at body root in a test fixture). */
  protected readonly mainScrimStyle = computed(() => {
    const rect = this.anchorRect();
    if (!rect) return { display: 'none' };
    const anchorEl = this.resolveAnchor(this.anchor());
    const containerRect = anchorEl?.parentElement?.getBoundingClientRect();
    const left = containerRect ? containerRect.right : rect.right;
    const inspector = this.inspectorRect();
    // When an inspector scrim is in play, the main scrim ends at the
    // inspector's left edge so the two scrims tile cleanly without
    // overlapping (overlapping doubled-stacked alphas would darken the
    // seam).
    const right = inspector ? Math.max(0, window.innerWidth - inspector.left) : 0;
    return {
      position: 'fixed' as const,
      top: '0px',
      bottom: '0px',
      left: `${left}px`,
      right: `${right}px`,
      background: `rgba(0, 0, 0, ${this.scrimOpacity()})`,
    };
  });

  protected readonly inspectorScrimStyle = computed(() => {
    const rect = this.inspectorRect();
    if (!rect) return { display: 'none' };
    return {
      position: 'fixed' as const,
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      background: `rgba(0, 0, 0, ${this.inspectorScrimOpacity()})`,
    };
  });

  @ViewChild('overlayEl') private overlayEl?: ElementRef<HTMLElement>;

  /** Element that owned focus when the overlay opened — restored on close. */
  private restoreFocusTo: HTMLElement | null = null;

  constructor() {
    // On open: capture restore-focus target, measure anchor rects, then
    // focus the first focusable inside the overlay panel once the @if
    // arm has flushed. On close: clear rects and restore focus to the
    // anchor (the source of truth for "what the user came from").
    effect(() => {
      if (!this.isOpen()) {
        this.anchorRect.set(null);
        this.inspectorRect.set(null);
        return;
      }
      this.restoreFocusTo = document.activeElement as HTMLElement | null;
      this.measure();
      // Defer focus so the @if arm has actually rendered the panel.
      queueMicrotask(() => {
        const panel = this.overlayEl?.nativeElement;
        if (!panel) return;
        const focusables = this.collectFocusables(panel);
        const target = focusables[0] ?? panel;
        target.focus({ preventScroll: true });
      });
    });
  }

  ngAfterViewInit(): void {
    // Initial measure if the overlay was opened before view init (rare,
    // but possible when a host binds [isOpen]="true" on mount).
    if (this.isOpen()) this.measure();
  }

  /** Read fresh bounding rects for the anchor + optional inspector. */
  private measure(): void {
    const anchorEl = this.resolveAnchor(this.anchor());
    if (anchorEl) this.anchorRect.set(anchorEl.getBoundingClientRect());
    const inspectorEl = this.inspectorAnchor();
    if (inspectorEl) {
      const el = this.resolveAnchor(inspectorEl);
      if (el) this.inspectorRect.set(el.getBoundingClientRect());
    } else {
      this.inspectorRect.set(null);
    }
  }

  private resolveAnchor(value: ElementRef<HTMLElement> | HTMLElement | null): HTMLElement | null {
    if (!value) return null;
    return value instanceof ElementRef ? value.nativeElement : value;
  }

  // ── Dismissal ─────────────────────────────────────────────────────────────

  protected onMainScrimClick(): void {
    this.close();
  }

  protected onInspectorScrimClick(): void {
    this.close();
  }

  /** Outside-click — listens at document level so taps anywhere except the
   * overlay panel itself dismiss. The scrims also dismiss (above), but
   * document-level catches clicks on the sidebar (which intentionally has
   * NO scrim) — without this, tapping a sidebar row outside the overlay
   * would leave the overlay open. */
  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.isOpen()) return;
    const target = event.target as Node | null;
    if (!target) return;
    const panel = this.overlayEl?.nativeElement;
    if (panel?.contains(target)) return;
    // The anchor itself toggles the overlay — let the host's click handler
    // run instead of double-dismissing. Without this guard, tapping the
    // pill while open would close (here) and immediately re-open (host).
    const anchorEl = this.resolveAnchor(this.anchor());
    if (anchorEl?.contains(target)) return;
    this.close();
  }

  /** Document-level Escape — mirrors BottomSheetComponent so behaviour is
   * consistent across overlay surfaces. */
  @HostListener('document:keydown.escape', ['$event'])
  protected onEscape(event: Event): void {
    if (!this.isOpen()) return;
    event.preventDefault();
    this.close();
  }

  /** Resize re-measures the anchor; spec calls out viewport-resize
   * tracking explicitly. Throttled implicitly by the browser's resize
   * event coalescing — no extra rAF needed for correctness, only for
   * polish. */
  @HostListener('window:resize')
  protected onResize(): void {
    if (!this.isOpen()) return;
    this.measure();
  }

  /** Tab cycle inside the overlay while open. Basic implementation:
   * intercepts Tab / Shift+Tab on document, computes the focusable list
   * inside the panel, wraps focus at the boundaries. Full WAI-ARIA
   * focus-trap (handling iframes, contenteditable nuance, etc.) is a
   * follow-up if the basic version misses real-world cases.
   *
   * Listener signature is `Event` because Angular's `HostListener` types
   * the binding loosely; we narrow inside (the `keydown.tab` filter
   * already guarantees KeyboardEvent at runtime). */
  @HostListener('document:keydown.tab', ['$event'])
  protected onTab(rawEvent: Event): void {
    const event = rawEvent as KeyboardEvent;
    if (!this.isOpen()) return;
    const panel = this.overlayEl?.nativeElement;
    if (!panel) return;
    const focusables = this.collectFocusables(panel);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  private collectFocusables(root: HTMLElement): HTMLElement[] {
    const sel =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(root.querySelectorAll<HTMLElement>(sel));
  }

  /** Internal close helper — fires the model output + restores focus. */
  private close(): void {
    this.isOpen.set(false);
    const target = this.restoreFocusTo;
    this.restoreFocusTo = null;
    if (target?.isConnected) {
      // Defer focus restoration so any synchronous close-time work (e.g.
      // the host's [(isOpen)] effect tearing down the overlay) settles
      // before we reach for the anchor.
      queueMicrotask(() => target.focus());
    }
  }
}
