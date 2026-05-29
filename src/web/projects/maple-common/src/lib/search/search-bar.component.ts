// SearchBarComponent — text input for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2.
//
// 38pt-tall pill with a `magnifyingglass` lead glyph, the typing surface,
// and a trailing ✕ clear-circle that appears once the query has ≥1 char.
// The caret-blink (1.5pt accent, 500ms) is browser-driven — we tune the
// stylesheet to expose the accent and the cadence rather than rolling a
// custom caret animation.
//
// Auto-focus on init is the responsibility of the host (`SearchComponent`)
// — phone tab activation, the search-pill drawer event, and the
// `autoFocus=1` query param all converge through one `focus()` call.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  input,
  output,
} from '@angular/core';

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
  /** Emitted on every keystroke (no internal debounce — host owns the
   * cadence so the recent-queries push and search fetch stay in lockstep). */
  readonly queryChange = output<string>();
  /** Emitted when the trailing ✕ is tapped. */
  readonly clear = output<void>();
  /** Emitted on Enter — the host treats this as "commit to recents". */
  readonly submit = output<void>();

  @ViewChild('input') private inputRef?: ElementRef<HTMLInputElement>;

  /** True once the user has typed something — controls ✕ visibility. */
  protected readonly hasQuery = computed(() => this.query().length > 0);

  /** Focus the field. Called by the host on tab activation or on the
   * drawer's `searchPillTap` event. Safe to call before the view is
   * initialised (no-op until the @ViewChild resolves). */
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
}
