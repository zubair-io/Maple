// MuiLivingSlider — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Gradient-track slider with a label + numeric readout, built from
// Text + Input. A clean design-system re-implementation of the Pro Editor's
// `LivingSliderComponent` (src/lib/components/develop/living-slider.component.ts)
// — same pointer-capture drag + keyboard-arrow contract, but self-contained
// and tokenized rather than importing that app component.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  computed,
  input,
  model,
  signal,
} from '@angular/core';
import { MuiTextComponent } from '../text/mui-text.component';
import {
  arrowKeyDelta,
  endPointerDrag,
  formatSignedValue,
  percentInRange,
} from '../internal/pointer-drag';

@Component({
  selector: 'mui-living-slider',
  standalone: true,
  imports: [MuiTextComponent],
  templateUrl: './mui-living-slider.component.html',
  styleUrl: './mui-living-slider.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiLivingSliderComponent implements OnDestroy {
  readonly label = input.required<string>();
  readonly value = model<number>(0);
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly step = input<number>(1);
  /** CSS `linear-gradient(...)` string painted on the track. */
  readonly gradient = input<string>(
    'linear-gradient(90deg, var(--color-border) 0%, var(--color-primary) 100%)',
  );
  /** True when `min` mirrors `max` around zero — draws a center notch. */
  readonly bipolar = input<boolean>(false);
  readonly unit = input<string>('');
  readonly disabled = input<boolean>(false);

  @ViewChild('trackEl') private trackRef!: ElementRef<HTMLElement>;

  readonly dragging = signal(false);
  private activePointerId: number | null = null;
  private pointerDownX = 0;
  private pointerDownValue = 0;
  private trackWidth = 0;

  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`thumbPct()`); fallow's member-usage scan doesn't follow external Angular templates.
  readonly thumbPct = computed(() => percentInRange(this.value(), this.min(), this.max(), 50));

  readonly valueLabel = computed(() => formatSignedValue(this.value(), this.step(), this.unit()));

  onPointerDown(event: PointerEvent): void {
    if (this.disabled() || event.button !== 0 || this.dragging()) return;
    const track = this.trackRef?.nativeElement;
    if (!track) return;

    this.trackWidth = track.getBoundingClientRect().width;
    this.dragging.set(true);
    this.activePointerId = event.pointerId;
    this.pointerDownX = event.clientX;
    this.pointerDownValue = this.value();
    track.setPointerCapture(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging() || event.pointerId !== this.activePointerId) return;
    if (this.trackWidth <= 0) return;

    const lo = this.min();
    const hi = this.max();
    const range = hi - lo;
    const dx = event.clientX - this.pointerDownX;
    const delta = (dx / this.trackWidth) * range;
    const raw = this.pointerDownValue + delta;
    const step = this.step();
    const snapped = Math.round(raw / step) * step;
    this.value.set(Math.min(hi, Math.max(lo, snapped)));
  }

  onPointerUp(event: PointerEvent): void {
    endPointerDrag(event, this.activePointerId, this.dragging, () => (this.activePointerId = null));
  }

  private cleanup(): void {
    this.dragging.set(false);
    this.activePointerId = null;
  }

  onKeydown(event: KeyboardEvent): void {
    const delta = arrowKeyDelta(event.key, this.step());
    if (delta === null) return;

    event.preventDefault();
    event.stopPropagation();
    const lo = this.min();
    const hi = this.max();
    this.value.set(Math.min(hi, Math.max(lo, this.value() + delta)));
  }

  @HostListener('dblclick')
  onDoubleClick(): void {
    if (this.disabled()) return;
    const lo = this.min();
    const hi = this.max();
    const zero = Math.min(hi, Math.max(lo, 0));
    this.value.set(zero);
  }

  ngOnDestroy(): void {
    this.cleanup();
  }
}
