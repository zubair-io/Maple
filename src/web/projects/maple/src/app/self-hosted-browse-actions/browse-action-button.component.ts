// BrowseActionButtonComponent — the "export-btn" pill button
// `SelfHostedBrowseActionsComponent` renders four near-identical copies of
// (Edit Metadata…, Merge to panorama…, Batch Rename…, Move to…) before
// this extraction (#2644 review — fallow-audit-web flagged the parent
// template as over the complexity threshold once the "Move to…" copy
// tipped it to a fourth). Each button was a 19-line block differing only in
// label/title/aria-label/click handler and the `canX()` gate feeding nine
// `[class.*]` bindings + `[disabled]` — this component is that block,
// parameterized, so the parent template is now four flat tags.
//
// Deliberately local to `self-hosted-browse-actions/`, not `maple-common`:
// this exact "export-btn has-selection/no-selection + trailing (`N`) count"
// look is specific to this one toolbar, not a general-purpose primitive —
// `maple-button.component.ts` is the actual shared button primitive
// elsewhere in the app, with a different variant set. Generalize this into
// `maple-common` only when a second, genuinely different call site needs
// the same look (YAGNI).

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

@Component({
  selector: 'app-browse-action-button',
  standalone: true,
  templateUrl: './browse-action-button.component.html',
  // Same `display: contents` as the parent's own host rule — this
  // component's single `<button>` needs to participate directly in the
  // parent's flex row, not be laid out as a block wrapping it.
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowseActionButtonComponent {
  /** Whether the action is available right now — drives the enabled/dim
   * visual state, `[disabled]`, and whether the trailing count shows. */
  readonly enabled = input.required<boolean>();
  readonly label = input.required<string>();
  /** Selection count appended as `" (N)"` when `enabled()` — `null` when
   * there's nothing to count (not currently used by any caller, but kept
   * so a future non-count action doesn't need a second component). */
  readonly count = input<number | null>(null);
  readonly buttonTitle = input.required<string>();
  readonly ariaLabel = input.required<string>();

  readonly clicked = output<void>();

  protected readonly displayLabel = computed(() => {
    const n = this.count();
    return this.enabled() && n !== null ? `${this.label()} (${n})` : this.label();
  });
}
