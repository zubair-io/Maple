import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MuiButtonComponent } from '@maple-common';

@Component({
  selector: 'app-browse-action-button',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './browse-action-button.component.html',
  styleUrl: './browse-action-button.component.scss',
  // Keep the shared button host in the parent toolbar's flex row.
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowseActionButtonComponent {
  /** Whether the action is available right now — drives the enabled/dim
   * visual state, `[disabled]`, and whether the trailing count shows. */
  readonly enabled = input.required<boolean>();
  readonly label = input.required<string>();
  readonly count = input.required<number>();
  readonly buttonTitle = input.required<string>();
  readonly ariaLabel = input.required<string>();

  readonly clicked = output<void>();

  protected readonly displayLabel = computed(() =>
    this.enabled() ? `${this.label()} (${this.count()})` : this.label(),
  );
}
