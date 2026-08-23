// MuiExportModal — Maple UI Organisms (unified-component-catalog.md §4.4).
// Format/size/quality/color-space export dialog, built from Overlay Shell,
// Segmented Toggle (format + color space pickers), Form Field (quality),
// Progress, and Banner. Presentational: the host owns the export request
// lifecycle and feeds `exporting`/`progress`/`resultBanner` back in as the
// job runs.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import type { MuiBannerVariant } from '../banner/mui-banner.component';
import { MuiBannerComponent } from '../banner/mui-banner.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import type { MuiSegmentedToggleOption } from '../segmented-toggle/mui-segmented-toggle.component';
import { MuiSegmentedToggleComponent } from '../segmented-toggle/mui-segmented-toggle.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiExportSettings {
  readonly format: string;
  readonly quality: number;
  readonly colorSpace: string;
}

export interface MuiExportResultBanner {
  readonly message: string;
  readonly variant: MuiBannerVariant;
}

@Component({
  selector: 'mui-export-modal',
  standalone: true,
  imports: [
    MuiBannerComponent,
    MuiButtonComponent,
    MuiFormFieldComponent,
    MuiOverlayShellComponent,
    MuiProgressComponent,
    MuiSegmentedToggleComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-export-modal.component.html',
  styleUrl: './mui-export-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiExportModalComponent {
  readonly open = input<boolean>(false);
  readonly formatOptions = input.required<readonly MuiSegmentedToggleOption[]>();
  readonly colorSpaceOptions = input.required<readonly MuiSegmentedToggleOption[]>();
  readonly format = model.required<string>();
  readonly quality = model<number>(90);
  readonly colorSpace = model.required<string>();
  readonly exporting = input<boolean>(false);
  /** 0–100, ignored while `exporting` is false. */
  readonly progress = input<number>(0);
  readonly resultBanner = input<MuiExportResultBanner | null>(null);

  /** Fires with the current settings when Export is pressed. */
  readonly exportRequested = output<MuiExportSettings>();
  /** Fires on Cancel, Escape, or an outside click. */
  readonly dismissed = output<void>();

  readonly qualityText = computed(() => String(this.quality()));

  onQualityCommitted(raw: string): void {
    const parsed = Number.parseInt(raw, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : this.quality();
    this.quality.set(clamped);
  }

  confirmExport(): void {
    this.exportRequested.emit({
      format: this.format(),
      quality: this.quality(),
      colorSpace: this.colorSpace(),
    });
  }
}
