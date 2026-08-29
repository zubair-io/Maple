// MuiBatchMetadataModal — Maple UI Organisms (unified-component-catalog.md
// §4.4). Multi-field metadata editor (copyright, keywords, rating) with a
// confirm-before-apply step, built from Overlay Shell, Form Field, Chip Row
// (keywords), a nested Dialog (confirm variant), and Progress.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import { MuiDialogComponent } from '../dialog/mui-dialog.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiBatchMetadataValues {
  readonly copyright: string;
  readonly keywords: readonly string[];
  readonly rating: number;
}

const MAX_RATING = 5;

@Component({
  selector: 'mui-batch-metadata-modal',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiChipRowComponent,
    MuiDialogComponent,
    MuiFormFieldComponent,
    MuiOverlayShellComponent,
    MuiProgressComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-batch-metadata-modal.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiBatchMetadataModalComponent {
  readonly open = input<boolean>(false);
  readonly itemCount = input<number>(0);
  readonly copyright = model<string>('');
  readonly keywords = model<readonly string[]>([]);
  readonly rating = model<number>(0);
  readonly applying = input<boolean>(false);
  /** 0–100, ignored while `applying` is false. */
  readonly progress = input<number>(0);

  /** Fires with the field values once the confirm step is accepted. */
  readonly applyRequested = output<MuiBatchMetadataValues>();
  readonly dismissed = output<void>();

  readonly confirmOpen = signal(false);

  readonly keywordChips = computed<readonly MuiChip[]>(() =>
    this.keywords().map((keyword) => ({ id: keyword, label: keyword })),
  );

  readonly ratingText = computed(() => String(this.rating()));

  readonly confirmMessage = computed(
    () =>
      `Apply copyright, ${this.keywords().length} keyword(s), and rating to ${this.itemCount()} item(s)?`,
  );

  onKeywordAdded(label: string): void {
    if (this.keywords().includes(label)) return;
    this.keywords.set([...this.keywords(), label]);
  }

  onKeywordRemoved(id: string): void {
    this.keywords.set(this.keywords().filter((keyword) => keyword !== id));
  }

  onRatingCommitted(raw: string): void {
    const parsed = Number.parseInt(raw, 10);
    const clamped = Number.isFinite(parsed)
      ? Math.min(MAX_RATING, Math.max(0, parsed))
      : this.rating();
    this.rating.set(clamped);
  }

  requestApply(): void {
    this.confirmOpen.set(true);
  }

  onConfirmed(): void {
    this.confirmOpen.set(false);
    this.applyRequested.emit({
      copyright: this.copyright(),
      keywords: this.keywords(),
      rating: this.rating(),
    });
  }

  onConfirmDismissed(): void {
    this.confirmOpen.set(false);
  }
}
