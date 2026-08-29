// BatchRenamePreviewListComponent — renders one row per already-normalized
// `BatchRenamePreviewRowVm` (see `batch-rename-preview-row.ts`). Shared by
// the dialog's edit phase (`BatchRenameFormComponent`, live before→after
// preview) and its done phase (`BatchRenameResultsComponent`, applied
// results) — both phases show the same "old → new [+ badge]" list shape,
// they just source it from a different type. Presentational only.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { BatchRenamePreviewRowVm } from './batch-rename-preview-row';

@Component({
  selector: 'app-batch-rename-preview-list',
  standalone: true,
  templateUrl: './batch-rename-preview-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchRenamePreviewListComponent {
  readonly rows = input.required<readonly BatchRenamePreviewRowVm[]>();
  readonly ariaLabel = input.required<string>();
  readonly loading = input<boolean>(false);
  readonly loadingLabel = input<string>('Loading…');

  /** Mutually-exclusive background pair for a row's error state (Tailwind
   * port #3071) — `brn-preview-row` kept bare (asserted in
   * batch-rename-dialog.component.spec.ts). */
  protected rowClass(isError: boolean): string {
    const base = 'brn-preview-row flex items-center gap-2 rounded p-1 text-[12px]';
    return isError ? `${base} bg-[color:var(--color-error-bg,rgba(220,38,38,0.08))]` : base;
  }

  /** Mutually-exclusive color pair for the new-name text's error state. */
  protected newTextClass(isError: boolean): string {
    const base =
      'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap';
    return isError ? `${base} text-error-text` : `${base} text-text-main`;
  }

  /** Mutually-exclusive color pair for the trailing success/warning badge. */
  protected badgeClass(kind: 'success' | 'warning'): string {
    const base = 'shrink-0 rounded-full px-1.5 py-px text-[10px]';
    return kind === 'success'
      ? `${base} bg-[color:var(--color-success-bg,rgba(22,163,74,0.15))] text-[color:var(--color-success-text,#16a34a)]`
      : `${base} bg-[color:var(--color-warning-bg,rgba(202,138,4,0.15))] text-[color:var(--color-warning-text,#b8860b)]`;
  }
}
