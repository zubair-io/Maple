// GeneratedSearchKnobsComponent — the editable settings form inside the
// Generated Searches panel.
//
// Split out of GeneratedSearchSettingsComponent because that panel does two
// unrelated things: operate the worker (this form) and display what it
// invented (the collections list). Keeping them in one template pushed it
// past the complexity budget, and they change for different reasons.
//
// Presentational: it owns no server state. The parent holds the draft and
// commits it, so a half-typed number never round-trips.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiButtonComponent, MuiCheckboxComponent, MuiInputComponent } from '@maple-common';

/** Editable copy of the worker's knobs. Mirrors the server's
 * `GeneratedSearchConfig` minus `paused`, which is the panel's own switch. */
export interface GeneratedSearchDraft {
  collections_per_day: number;
  min_results: number;
  max_rounds: number;
  retention_days: number;
  model: string;
  dry_run: boolean;
}

@Component({
  selector: 'maple-generated-search-knobs',
  standalone: true,
  imports: [MuiButtonComponent, MuiCheckboxComponent, MuiInputComponent],
  templateUrl: './generated-search-knobs.component.html',
  styleUrl: './generated-search-knobs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GeneratedSearchKnobsComponent {
  readonly draft = input.required<GeneratedSearchDraft>();
  readonly saving = input(false);

  readonly changed = output<GeneratedSearchDraft>();
  readonly save = output<void>();

  protected patch<K extends keyof GeneratedSearchDraft>(
    key: K,
    value: GeneratedSearchDraft[K],
  ): void {
    this.changed.emit({ ...this.draft(), [key]: value });
  }

  /** mui-input carries every variant's value as a string; numeric knobs patch
   * back the parsed number on commit. */
  protected patchNumber<K extends keyof GeneratedSearchDraft & string>(key: K, raw: string): void {
    this.patch(key, Number(raw) as GeneratedSearchDraft[K]);
  }

  protected numberToString(value: number): string {
    return String(value);
  }
}
