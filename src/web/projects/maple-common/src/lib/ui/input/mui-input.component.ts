// MuiInput — the Maple UI design-system Input atom
// (docs/design/maple-ui/components/input.md). A single-line text entry
// field. Adds the catalog's numeric variant (with increment/decrement
// steppers) on top of the contract's default/search pair — the contract's
// Props section is silent on it, same "harmless addition" precedent as
// Badge's `size` in wave 1.
//
// `masked` (MW1, ticket #3020): renders the native control as
// `type="password"` instead of `type="text"`. Added migrating the Settings
// surfaces off hand-rolled markup — the legacy Meilisearch API-key field used
// a real `<input type="password">` so the secret isn't shown in plaintext on
// screen, and mui-input had no way to preserve that. Orthogonal to `variant`
// (masking a search/numeric field is nonsensical but not this component's
// call to forbid).

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';

export type MuiInputVariant = 'default' | 'search' | 'numeric';
export type MuiInputSize = 'sm' | 'md';

@Component({
  selector: 'mui-input',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-input.component.html',
  styleUrl: './mui-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiInputComponent {
  readonly variant = input<MuiInputVariant>('default');
  readonly size = input<MuiInputSize>('md');
  /** Two-way bound value — every variant (including numeric) carries its
   * value as a string; the numeric variant's steppers parse/format it. */
  readonly value = model<string>('');
  readonly placeholder = input<string>('');
  readonly disabled = input<boolean>(false);
  readonly readOnly = input<boolean>(false);
  /** Renders the native control as `type="password"`, masking the entered
   * value on screen. */
  readonly masked = input<boolean>(false);
  /** Forwarded to the native control's `autocomplete` attribute — e.g. `'off'`
   * for a secret field the browser shouldn't offer to save/autofill. */
  readonly autocomplete = input<string | null>(null);
  /** Presence triggers the Error state; the string renders as helper text. */
  readonly error = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly min = input<number | null>(null);
  readonly max = input<number | null>(null);
  readonly step = input<number>(1);

  /** Fires on Enter or blur — the "committed" moment per the contract's
   * `onCommit` callback. `value`'s own `valueChange` output (from `model()`)
   * already covers the keystroke-level `onChange` callback. */
  readonly committed = output<string>();

  readonly focused = signal<boolean>(false);

  /** The native control's `type` attribute — computed here rather than as a
   * template ternary so the template's own branch count doesn't grow (fallow
   * complexity gate; MW1, ticket #3020). */
  readonly controlType = computed(() => (this.masked() ? 'password' : 'text'));

  readonly isFilled = computed(() => this.value().trim().length > 0);
  readonly showClear = computed(
    () => this.variant() === 'search' && this.isFilled() && !this.disabled() && !this.readOnly(),
  );

  onInput(raw: string): void {
    this.value.set(raw);
  }

  onFocus(): void {
    this.focused.set(true);
  }

  onBlur(): void {
    this.focused.set(false);
    this.committed.emit(this.value());
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.committed.emit(this.value());
  }

  clear(): void {
    this.value.set('');
    this.committed.emit('');
  }

  stepBy(direction: 1 | -1): void {
    if (this.disabled() || this.readOnly()) return;
    const current = Number.parseFloat(this.value()) || 0;
    const next = current + direction * this.step();
    const clamped = this.clampToRange(next);
    this.value.set(String(clamped));
    this.committed.emit(String(clamped));
  }

  private clampToRange(next: number): number {
    const min = this.min();
    const max = this.max();
    const lowered = min !== null && next < min ? min : next;
    return max !== null && lowered > max ? max : lowered;
  }
}
