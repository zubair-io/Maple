// LivingSliderComponent — canvas-first gradient track slider (#1535).
// Replaces EditorSliderComponent in the Pro Editor context.
//
// Track: 8–9px rounded, gradient from catalog, inset hairline + inner
// shadow. Bipolar: 1.5px white zero-notch at track midpoint. Thumb: white,
// track-height+8px, dark rim, 2px accent ring when value≠default.
// Value text: mono tabular-nums, signed, accent when modified / dim at 0.
//
// Drag is 1:1 — pointer captures on mousedown, moves to track geometry.
// Double-click resets to zero (single-param) or calls resetArmedTool.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

@Component({
  selector: 'pro-living-slider',
  standalone: true,
  imports: [],
  templateUrl: './living-slider.component.html',
  styleUrl: './living-slider.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
})
export class LivingSliderComponent implements OnDestroy {
  // ── Inputs ────────────────────────────────────────────────────────────
  label = input.required<string>();
  value = input.required<number>();
  min = input.required<number>();
  max = input.required<number>();
  step = input<number>(1);
  /** CSS linear-gradient string from gradient-catalog. */
  gradient = input<string>('linear-gradient(90deg, #4a443b 0%, #a8a097 100%)');
  /** True when `min` is the mirror of `max` around zero (e.g. ±100). */
  bipolar = input<boolean>(false);
  /** Pre-formatted display value string (e.g. "+2.3 EV"). Shown when provided. */
  displayValue = input<string | null>(null);
  /** Unit suffix appended to the numeric value when displayValue is not set. */
  unit = input<string>('');
  /** Default value for the reset-on-double-click. Defaults to 0. */
  defaultValue = input<number>(0);

  // ── Outputs ───────────────────────────────────────────────────────────
  valueChange = output<number>();
  /** Fired when the user double-clicks the slider to request a reset. */
  resetRequest = output<void>();

  // ── Internal ──────────────────────────────────────────────────────────
  @ViewChild('trackEl') trackRef!: ElementRef<HTMLElement>;

  readonly dragging = signal(false);
  private _pointerDownX = 0;
  private _pointerDownValue = 0;
  private _cachedTrackWidth = 0;
  private _boundPointerMove: ((e: PointerEvent) => void) | null = null;
  private _boundPointerUp: ((e: PointerEvent) => void) | null = null;
  private _boundPointerCancel: ((e: PointerEvent) => void) | null = null;

  // ── View model ────────────────────────────────────────────────────────

  /** Thumb position as percent [0..100] of track width. */
  readonly thumbPct = computed<number>(() => {
    const v = this.value();
    const lo = this.min();
    const hi = this.max();
    if (hi === lo) return 50;
    return ((v - lo) / (hi - lo)) * 100;
  });

  /** True when the current value differs from the default. */
  readonly isModified = computed<boolean>(() => {
    return Math.abs(this.value() - this.defaultValue()) > 1e-9;
  });

  /** Formatted label for the value chip. */
  readonly valueLabel = computed<string>(() => {
    const dv = this.displayValue();
    if (dv !== null) return dv;

    const v = this.value();
    const step = this.step();
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    const formatted = v.toFixed(decimals);
    const signed = v > 0 ? `+${formatted}` : formatted;
    const u = this.unit();
    return u ? `${signed} ${u}` : signed;
  });

  // ── Drag handling ─────────────────────────────────────────────────────

  onTrackPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;

    const track = this.trackRef?.nativeElement;
    if (!track) return;

    // Cache track width once at drag start (avoids getBoundingClientRect on
    // every move tick — Fix #4). Touch scrolling is already suppressed by
    // `touch-action: none` on .track-wrap in the stylesheet (Fix #3).
    this._cachedTrackWidth = track.getBoundingClientRect().width;

    this.dragging.set(true);
    this._pointerDownX = e.clientX;
    this._pointerDownValue = this.value();

    this._boundPointerMove = (ev: PointerEvent) => this._onPointerMove(ev);
    this._boundPointerUp = (ev: PointerEvent) => this._onPointerUp(ev);
    // pointercancel (system gesture takeover, context menu, tab switch) must
    // also tear down the drag, else the window listeners leak and the slider
    // stays stuck in its dragging state.
    this._boundPointerCancel = (ev: PointerEvent) => this._onPointerUp(ev);
    window.addEventListener('pointermove', this._boundPointerMove);
    window.addEventListener('pointerup', this._boundPointerUp);
    window.addEventListener('pointercancel', this._boundPointerCancel);
    track.setPointerCapture(e.pointerId);
  }

  private _onPointerMove(e: PointerEvent): void {
    const trackW = this._cachedTrackWidth;
    if (trackW <= 0) return;

    const dx = e.clientX - this._pointerDownX;
    const lo = this.min();
    const hi = this.max();
    const range = hi - lo;
    const delta = (dx / trackW) * range;

    const raw = this._pointerDownValue + delta;
    const step = this.step();
    const snapped = Math.round(raw / step) * step;
    const clamped = Math.min(hi, Math.max(lo, snapped));

    this.valueChange.emit(clamped);
  }

  private _onPointerUp(_e: PointerEvent): void {
    this._cleanup();
  }

  private _cleanup(): void {
    this.dragging.set(false);
    if (this._boundPointerMove) {
      window.removeEventListener('pointermove', this._boundPointerMove);
      this._boundPointerMove = null;
    }
    if (this._boundPointerUp) {
      window.removeEventListener('pointerup', this._boundPointerUp);
      this._boundPointerUp = null;
    }
    if (this._boundPointerCancel) {
      window.removeEventListener('pointercancel', this._boundPointerCancel);
      this._boundPointerCancel = null;
    }
  }

  /** Keyboard operation for the focused track (role="slider" + tabindex="0").
   * ArrowLeft/Down decrement by step; ArrowRight/Up increment by step.
   * All other keys pass through.
   *
   * `stopPropagation` on the keys this handler consumes (#2409) — without it
   * the event bubbles to the editor shell's global `document:keydown`
   * listener, whose bare-arrow filmstrip-navigation shortcut then fires on
   * top of this one and silently switches the focused image. */
  onTrackKeyDown(e: KeyboardEvent): void {
    const lo = this.min();
    const hi = this.max();
    const s = this.step();
    let delta = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      delta = -s;
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      delta = s;
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const next = Math.min(hi, Math.max(lo, this.value() + delta));
    this.valueChange.emit(next);
  }

  /** Double-click resets to default. */
  @HostListener('dblclick')
  onDoubleClick(): void {
    this.resetRequest.emit();
  }

  ngOnDestroy(): void {
    this._cleanup();
  }
}
