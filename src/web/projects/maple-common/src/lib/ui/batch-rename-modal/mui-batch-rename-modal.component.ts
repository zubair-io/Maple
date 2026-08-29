// MuiBatchRenameModal — Maple UI Organisms (unified-component-catalog.md
// §4.4). Template-driven rename with a live preview list, built from
// Overlay Shell, Form Field (template text), Chip Row (insertable tokens),
// Preview List, and Progress. The rename mapping is computed live —
// `previewItems` is a pure function of `items`, `template`, and
// `startNumber`, recomputed on every keystroke.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import type { MuiPreviewItem } from '../preview-list/mui-preview-list.component';
import { MuiPreviewListComponent } from '../preview-list/mui-preview-list.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiBatchRenameSourceItem {
  readonly id: string;
  readonly filename: string;
  /** ISO date string (or `YYYY-MM-DD`) the `{date}` token formats from. */
  readonly date: string;
  readonly camera?: string;
}

export interface MuiBatchRenameResult {
  readonly template: string;
  readonly mapping: readonly MuiPreviewItem[];
}

/** The only tokens the template substitution understands — fixed because
 * `applyTemplate` only knows how to fill these three in. */
const TOKENS: readonly MuiChip[] = [
  { id: 'date', label: '{date}' },
  { id: 'seq', label: '{seq}' },
  { id: 'camera', label: '{camera}' },
];

const SEQ_PAD_WIDTH = 3;

@Component({
  selector: 'mui-batch-rename-modal',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiChipRowComponent,
    MuiFormFieldComponent,
    MuiOverlayShellComponent,
    MuiPreviewListComponent,
    MuiProgressComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-batch-rename-modal.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBatchRenameModalComponent {
  readonly open = input<boolean>(false);
  readonly items = input.required<readonly MuiBatchRenameSourceItem[]>();
  readonly template = model<string>('{date}_{seq}');
  readonly startNumber = input<number>(1);
  readonly renaming = input<boolean>(false);
  /** 0–100, ignored while `renaming` is false. */
  readonly progress = input<number>(0);

  /** Fires with the final template and its computed before/after mapping. */
  readonly renameConfirmed = output<MuiBatchRenameResult>();
  readonly dismissed = output<void>();

  readonly tokens = TOKENS;

  readonly previewItems = computed<readonly MuiPreviewItem[]>(() => {
    const tmpl = this.template();
    const start = this.startNumber();
    return this.items().map((item, index) => ({
      id: item.id,
      before: item.filename,
      after: this.applyTemplate(tmpl, item, start + index),
    }));
  });

  onTokenClicked(tokenId: string | null): void {
    const token =
      tokenId === null ? undefined : this.tokens.find((candidate) => candidate.id === tokenId);
    if (!token) return;
    this.template.set(this.template() + token.label);
  }

  confirmRename(): void {
    this.renameConfirmed.emit({ template: this.template(), mapping: this.previewItems() });
  }

  private applyTemplate(tmpl: string, item: MuiBatchRenameSourceItem, seq: number): string {
    const dateText = this.formatDate(item.date);
    const seqText = String(seq).padStart(SEQ_PAD_WIDTH, '0');
    return tmpl
      .replaceAll('{date}', dateText)
      .replaceAll('{seq}', seqText)
      .replaceAll('{camera}', item.camera ?? '');
  }

  private formatDate(dateIso: string): string {
    const parsed = new Date(dateIso);
    return Number.isNaN(parsed.getTime()) ? dateIso : parsed.toISOString().slice(0, 10);
  }
}
