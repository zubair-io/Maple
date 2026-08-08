// BatchRenameFormComponent — the 'edit'/'applying' phase of the Batch
// Rename dialog (#2640): the template-token form, the live preview list,
// and the Cancel/Apply footer. Split out of `BatchRenameDialogComponent`
// (which owns phase-switching + all the HTTP/debounce logic) purely to
// keep each template's complexity in check — the combined single-template
// version tripped fallow's template-complexity gate (201 lines, CRITICAL).
// Presentational only: every value in is an input, every action out is an
// output: the parent still owns all the state.

import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { BatchRenamePreviewListComponent } from './batch-rename-preview-list.component';
import { previewItemToRow } from './batch-rename-preview-row';
import type {
  BatchRenameCollisionPolicy,
  BatchRenamePreviewItem,
  BatchRenameTokenHelp,
} from './batch-rename.types';

export interface BatchRenameCollisionOption {
  value: BatchRenameCollisionPolicy;
  label: string;
}

@Component({
  selector: 'app-batch-rename-form',
  standalone: true,
  imports: [BatchRenamePreviewListComponent],
  templateUrl: './batch-rename-form.component.html',
  styleUrl: './batch-rename-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchRenameFormComponent {
  readonly template = input.required<string>();
  readonly sequenceStart = input.required<number>();
  readonly sequencePadWidth = input.required<number>();
  readonly collision = input.required<BatchRenameCollisionPolicy>();
  readonly maxTemplateLength = input.required<number>();
  readonly tokenHelp = input.required<readonly BatchRenameTokenHelp[]>();
  readonly collisionOptions = input.required<readonly BatchRenameCollisionOption[]>();

  readonly resolving = input.required<boolean>();
  readonly hasUnresolved = input.required<boolean>();
  readonly unresolvedMessage = input<string>('');

  readonly previewLoading = input.required<boolean>();
  readonly previewItems = input.required<readonly BatchRenamePreviewItem[]>();
  readonly previewError = input<string | null>(null);
  readonly applyError = input<string | null>(null);
  readonly duplicateCount = input.required<number>();

  readonly canApply = input.required<boolean>();
  readonly busy = input.required<boolean>();

  readonly templateInput = output<string>();
  readonly sequenceStartInput = output<string>();
  readonly sequencePadWidthInput = output<string>();
  readonly collisionChange = output<string>();
  readonly insertToken = output<string>();
  readonly apply = output<void>();
  readonly cancel = output<void>();

  /** Normalized once here so the template is just "loading, or a list" —
   * see `batch-rename-preview-row.ts`'s module doc. */
  readonly previewRows = computed(() => this.previewItems().map(previewItemToRow));

  readonly previewListLoading = computed(
    () => this.resolving() || (this.previewLoading() && this.previewItems().length === 0),
  );
}
