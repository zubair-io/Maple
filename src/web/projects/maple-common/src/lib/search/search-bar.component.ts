// SearchBarComponent — the unified-search pill (#2865).
//
// One rounded bar holding, left to right: the magnifier glyph, the inline
// active-filter chips (host-capped; the "+N" overflow button opens the
// Filters panel), the typing surface, the ✕ clear-circle, and the Filters
// control with its active-count badge. The chips live INSIDE the pill so
// "query + filters" reads as one composed search, matching the design.
//
// Purely presentational: filter state lives in the host (`SearchComponent`)
// and arrives pre-derived as `chips` / `overflowCount` / `filterCount`.
//
// Auto-focus on init is the responsibility of the host — phone tab
// activation and the `autoFocus=1` query param converge on one `focus()`.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  output,
} from '@angular/core';
import type { ActiveFilterChip } from './search-filters';

@Component({
  selector: 'app-search-bar',
  standalone: true,
  templateUrl: './search-bar.component.html',
  styleUrl: './search-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchBarComponent {
  /** Current query value — owned by the host. */
  readonly query = input<string>('');
  /** Inline active-filter chips, already capped by the host. */
  readonly chips = input<readonly ActiveFilterChip[]>([]);
  /** Chips beyond the inline cap — rendered as a "+N" button. */
  readonly overflowCount = input<number>(0);
  /** Total active filters — the Filters-button badge (hidden at 0). */
  readonly filterCount = input<number>(0);

  /** Emitted on every keystroke (no internal debounce — host owns the
   * cadence so the recent-queries push and search fetch stay in lockstep). */
  readonly queryChange = output<string>();
  /** Emitted when the trailing ✕ is tapped. */
  readonly clear = output<void>();
  /** Emitted on Enter — the host treats this as "commit to recents". */
  readonly submit = output<void>();
  /** Emitted when a chip's remove ✕ is tapped. */
  readonly chipRemove = output<ActiveFilterChip>();
  /** Emitted by the Filters control and the "+N" overflow chip. */
  readonly filtersTap = output<void>();

  @ViewChild('input') private inputRef?: ElementRef<HTMLInputElement>;

  /** True once the user has typed something — controls ✕ visibility. */
  protected readonly hasQuery = computed(() => this.query().length > 0);

  /** Focus the field. Called by the host on tab activation. Safe to call
   * before the view is initialised (no-op until the @ViewChild resolves). */
  focus(): void {
    this.inputRef?.nativeElement.focus();
  }

  protected onInput(e: Event): void {
    this.queryChange.emit((e.target as HTMLInputElement).value);
  }

  protected onSubmit(e: Event): void {
    e.preventDefault();
    this.submit.emit();
  }

  protected onClearClick(): void {
    this.clear.emit();
    // Re-focus the field so the keyboard stays up on mobile.
    this.inputRef?.nativeElement.focus();
  }

  protected chipIcon(chip: ActiveFilterChip): 'event' | 'person' | 'place' {
    return chip.kind === 'date' ? 'event' : chip.kind;
  }
}
