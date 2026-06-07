import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * A collapsible settings row — the shared shell behind the worker stage rows,
 * import rows, and the mirror section (DRY; see issue #942).
 *
 * It owns the repeated, easy-to-get-wrong part: the `.row` container, the
 * clickable `.row-summary` with full keyboard accessibility (`role="button"`,
 * `aria-expanded`, Enter/Space toggle), and the conditional `.expanded` body.
 * State is controlled by the parent via `[expanded]` + `(toggle)` so each
 * consumer keeps owning how it tracks expansion.
 *
 * Each consumer projects its own summary content into the `[srow-summary]`
 * slot (a single container — `.row-grid` for the worker/import tables, a flex
 * row for the mirror) and the expanded body into the default slot. Keeping the
 * layout in the consumer means the worker grid template stays co-located with
 * its column header, and projected content is styled by the consumer's own
 * stylesheet.
 */
@Component({
  selector: 'maple-settings-row',
  standalone: true,
  template: `
    <div class="row" [class.is-expanded]="expanded()" [attr.data-testid]="testid()">
      <div
        class="row-summary"
        (click)="toggle.emit()"
        role="button"
        [attr.aria-expanded]="expanded()"
        tabindex="0"
        (keydown.enter)="toggle.emit()"
        (keydown.space)="toggle.emit(); $event.preventDefault()"
      >
        <ng-content select="[srow-summary]" />
      </div>

      @if (expanded()) {
        <div class="expanded">
          <ng-content />
        </div>
      }
    </div>
  `,
  styleUrl: './settings-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsRowComponent {
  /** Whether the body is shown. Controlled by the parent. */
  readonly expanded = input(false);
  /** Optional `data-testid` for the row container. */
  readonly testid = input<string>();
  /** Emitted on click / Enter / Space — the parent flips its own state. */
  readonly toggle = output<void>();
}
