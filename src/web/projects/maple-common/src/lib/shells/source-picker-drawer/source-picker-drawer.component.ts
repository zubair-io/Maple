// SourcePickerDrawerComponent — Library-tab-scoped source picker drawer.
// Part of S1b of the responsive-program epic (#577 / ticket #598). Spec:
// docs/spec/responsive-program-s1-phone-shell.md §3.
//
// The drawer overlays the Library tab content on phone-tier viewports
// (<768px). Header chrome (LIBRARY eyebrow, close X, connection identity,
// search pill) lives in this component; the source tree is supplied via
// the `sourceTree` input so the caller can swap implementations later
// without touching the chrome.
//
// Two-way `isOpen` model + outputs let the host (BrowseShell, once the web
// responsive foundation retires the S1a phone-tab fork — #2279) own the
// open/closed state and react to user choices:
//   - `sourceSelected(id)` — user tapped a source row, drawer closes itself.
//   - `searchPillTap()`    — user tapped the search pill, drawer closes
//     itself, host should switch to the Search tab and post a focus event.
//
// PointerEvents pan-left dismiss is wired inline. Threshold = 30% of the
// drawer width per spec §3.1.
//
// Motion tokens — S0a (PR #586) introduces `--motion-drawer-ms` /
// `--motion-drawer-ease`. Until that ships, the SCSS uses the literal
// `240ms cubic-bezier(0.22, 1, 0.36, 1)` values from the same spec.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';

import { SidebarEntry } from '../../models/folder';

@Component({
  selector: 'app-source-picker-drawer',
  standalone: true,
  imports: [],
  templateUrl: './source-picker-drawer.component.html',
  styleUrl: './source-picker-drawer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourcePickerDrawerComponent {
  /** Two-way bound — host controls open state, drawer can close itself. */
  readonly isOpen = model<boolean>(false);
  /** Flat list of top-level source entries (typically FOLDERS / PHOTOS
   * LIBRARY / ALBUMS sections). The drawer doesn't own tree-expansion
   * state — it renders whatever is passed in. */
  readonly sourceTree = input.required<SidebarEntry[]>();
  /** Optional connection identity row (e.g. `"maple.lawrence.io"`). Empty
   * string hides the row. */
  readonly connectionIdentity = input<string>('');
  /** Optional tertiary summary row (e.g. `"12,481 photos · 2m"`). Empty
   * string hides the row. */
  readonly tertiarySummary = input<string>('');

  /** Emitted when the user taps a source row (any non-section entry). */
  readonly sourceSelected = output<string>();
  /** Emitted when the user taps the search pill. Drawer closes itself
   * before emit; host should switch to the Search tab on receipt. */
  readonly searchPillTap = output<void>();

  /** In-flight finger translation during a pan-left close drag. Reset to
   * null at pointerup; null means "not dragging" so SCSS applies its
   * normal transition. */
  protected readonly dragDx = signal<number | null>(null);

  /** CSS transform applied to the drawer element. Clamped so a rightward
   * drag while open is a no-op (drawer is already at rest). */
  protected readonly drawerTransform = computed(() => {
    const dx = this.dragDx();
    if (dx === null) return 'translateX(0)';
    return `translateX(${Math.min(0, dx)}px)`;
  });

  /** Dim-overlay opacity tracks how much of the drawer is visible. */
  protected readonly scrimOpacity = computed(() => {
    const dx = this.dragDx();
    if (dx === null) return 1;
    // Width is min(326px, 81vw); read the live width off the host element
    // so opacity tracks the actual rendered drawer. Falls back to 326 if
    // the host element isn't measurable yet.
    const w = this.elRef.nativeElement.querySelector('.drawer')?.clientWidth ?? 326;
    const visible = Math.max(0, w + Math.min(0, dx));
    return Math.max(0, Math.min(1, visible / w));
  });

  private readonly elRef = inject(ElementRef<HTMLElement>);
  private pointerId: number | null = null;
  private pointerStartX = 0;

  // ── User actions ─────────────────────────────────────────────────────────

  protected onSelectSource(entry: SidebarEntry, e: Event): void {
    e.stopPropagation();
    // Section / subheader rows are not selectable — they're visual group
    // headers in the tree, not real sources.
    if (entry.kind === 'section' || entry.kind === 'subheader') return;
    this.sourceSelected.emit(entry.id);
    this.isOpen.set(false);
  }

  protected onSearchPillTap(): void {
    // Close ourselves first so the host doesn't have to remember to do it
    // before swapping tabs.
    this.isOpen.set(false);
    this.searchPillTap.emit();
  }

  protected onClose(): void {
    this.isOpen.set(false);
  }

  // ── Pan-left close drag (PointerEvents) ──────────────────────────────────
  //
  // Mirrors the Apple drawer's drag-close gesture. Threshold = 30% of the
  // drawer's measured width per spec §3.1. Scrim opacity + transform are
  // computed signals so SwiftUI-equivalent reactivity comes for free.

  protected onPointerDown(e: PointerEvent): void {
    // Only respond to the primary pointer; secondary touches (multi-touch
    // pinch) should not start a drag.
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.pointerStartX = e.clientX;
    this.dragDx.set(0);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  protected onPointerMove(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    const dx = e.clientX - this.pointerStartX;
    // Clamp the displayed drag to leftward motion only — rightward motion
    // while the drawer is at rest is a no-op visually.
    this.dragDx.set(dx);
  }

  protected onPointerUp(e: PointerEvent): void {
    if (this.pointerId !== e.pointerId) return;
    const dx = this.dragDx() ?? 0;
    this.pointerId = null;
    this.dragDx.set(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* Pointer may already be released; safe to swallow. */
    }
    // Threshold = 30% of measured drawer width. Reading clientWidth off
    // the rendered DOM rather than re-deriving from the viewport keeps the
    // threshold honest if the responsive `min(326px, 81vw)` rule clamps it.
    const w = this.elRef.nativeElement.querySelector('.drawer')?.clientWidth ?? 326;
    if (dx <= -w * 0.3) {
      this.isOpen.set(false);
    }
  }

  /** Escape key closes the drawer — keyboard accessibility for desktop
   * preview / power users. Bound at document level so it fires regardless
   * of focus inside the drawer. */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.isOpen()) this.isOpen.set(false);
  }
}
