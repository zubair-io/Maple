// TrashToolbarComponent — the panel's "Restore All" / "Empty Trash"
// buttons (#2652). Split out of `trash-panel.component.html` to keep that
// template from growing past fallow-audit-web's complexity threshold once
// the disabled-reason `aria-describedby` wiring (#2749 review) was added —
// a plain presentational component, no service/HTTP imports of its own.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

@Component({
  selector: 'app-trash-toolbar',
  standalone: true,
  templateUrl: './trash-toolbar.component.html',
  styleUrl: './trash-toolbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashToolbarComponent {
  /** Why both actions are disabled right now, or `null` when they're not —
   * see `TrashPanelComponent.toolbarDisabledReason`'s doc comment for why
   * one reason serves both buttons. */
  readonly disabledReason = input<string | null>(null);

  readonly restoreAll = output<void>();
  readonly emptyTrash = output<void>();
}
