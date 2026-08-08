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
  styleUrl: './batch-rename-preview-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchRenamePreviewListComponent {
  readonly rows = input.required<readonly BatchRenamePreviewRowVm[]>();
  readonly ariaLabel = input.required<string>();
  readonly loading = input<boolean>(false);
  readonly loadingLabel = input<string>('Loading…');
}
