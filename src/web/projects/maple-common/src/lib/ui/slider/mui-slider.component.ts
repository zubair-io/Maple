// MuiSlider — Maple UI Molecules-L1 (docs/design/maple-ui/components/slider.md).
// Labeled range slider with a numeric readout, an optional helper line and a
// `commit` output, built on a native `input[type=range]` (styled with tokens)
// so keyboard operation (arrow keys, Home/End, Page Up/Down) and
// screen-reader semantics come for free.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { percentInRange } from '../internal/pointer-drag';
import { formatSliderReadout, spokenSliderValue } from './slider-readout';

export type MuiSliderHelperTone = 'muted' | 'warning';

let nextHelperId = 0;

const VALUE_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

@Component({
  selector: 'mui-slider',
  standalone: true,
  imports: [MuiTextComponent, MuiIconComponent],
  templateUrl: './mui-slider.component.html',
  styleUrl: './mui-slider.component.scss',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiSliderComponent {
  readonly label = input.required<string>();
  readonly value = model<number>(0);
  readonly min = input<number>(0);
  readonly max = input<number>(100);
  readonly step = input<number>(1);
  readonly unit = input<string>('');
  readonly disabled = input<boolean>(false);
  readonly helper = input<string | null>(null);
  readonly helperTone = input<MuiSliderHelperTone>('muted');

  /** Fires once with the final value when a drag or key press ends, and not
   * when the value ends where the change began. */
  readonly commit = output<number>();

  readonly helperId = `mui-slider-helper-${nextHelperId++}`;

  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view (`trackPct()`); fallow's member-usage scan doesn't follow external Angular templates.
  readonly trackPct = computed(() => percentInRange(this.value(), this.min(), this.max(), 0));

  readonly valueLabel = computed(() =>
    formatSliderReadout(this.value(), this.min(), this.step(), this.unit()),
  );

  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view.
  readonly spokenValue = computed(() =>
    spokenSliderValue(this.value(), this.min(), this.step(), this.unit()),
  );

  // A warning helper is state, announced by its `role="status"` container;
  // only the muted helper is linked as a description (contract § Accessibility).
  // fallow-ignore-next-line unused-class-member -- read from the templateUrl view.
  readonly describedBy = computed(() =>
    this.helper() && this.helperTone() === 'muted' ? this.helperId : null,
  );

  private valueBeforeChange: number | null = null;
  private keyHeld = false;

  onInput(raw: string): void {
    this.valueBeforeChange ??= this.value();
    this.value.set(Number.parseFloat(raw));
  }

  // fallow-ignore-next-line unused-class-member -- bound from the templateUrl view.
  onChange(): void {
    if (!this.keyHeld) this.finishChange();
  }

  // fallow-ignore-next-line unused-class-member -- bound from the templateUrl view.
  onKeydown(event: KeyboardEvent): void {
    if (VALUE_KEYS.has(event.key)) this.keyHeld = true;
  }

  // fallow-ignore-next-line unused-class-member -- bound from the templateUrl view.
  onKeyup(): void {
    if (!this.keyHeld) return;
    this.keyHeld = false;
    this.finishChange();
  }

  // The key-up of a key held while focus leaves goes to another element.
  // fallow-ignore-next-line unused-class-member -- bound from the templateUrl view.
  onBlur(): void {
    this.keyHeld = false;
    this.finishChange();
  }

  // fallow-ignore-next-line unused-class-member -- bound from the templateUrl view.
  finishChange(): void {
    const start = this.valueBeforeChange;
    this.valueBeforeChange = null;
    if (start !== null && start !== this.value()) this.commit.emit(this.value());
  }
}
