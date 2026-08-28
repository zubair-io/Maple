// MuiExportOptionsFields — the format/quality/color-space/size field block
// for `mui-export-modal`'s options pane, split into its own presentational
// component (#3046) purely to keep `mui-export-modal`'s own template under
// the complexity gate — the parent's options case, plus the phase switch
// it sits inside, pushed the SAME template past threshold once the size
// picker and choice blurbs were added (a real restructure, not a
// behavior change: every input/output here is the same view-model
// `export-dialog.component.ts` already computes, just addressed one level
// deeper).

import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import type { MuiSegmentedToggleOption } from '../segmented-toggle/mui-segmented-toggle.component';
import { MuiSegmentedToggleComponent } from '../segmented-toggle/mui-segmented-toggle.component';
import { MuiTextComponent } from '../text/mui-text.component';
import type { MuiExportSizeOption } from './mui-export-modal.component';

@Component({
  selector: 'mui-export-options-fields',
  standalone: true,
  imports: [MuiFormFieldComponent, MuiSegmentedToggleComponent, MuiTextComponent],
  templateUrl: './mui-export-options-fields.component.html',
  styleUrl: './mui-export-options-fields.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiExportOptionsFieldsComponent {
  readonly formatOptions = input.required<readonly MuiSegmentedToggleOption[]>();
  readonly colorSpaceOptions = input.required<readonly MuiSegmentedToggleOption[]>();
  readonly format = model.required<string>();
  readonly quality = model<number>(90);
  readonly colorSpace = model.required<string>();
  readonly disabled = input<boolean>(false);
  readonly formatDetail = input<string | null>(null);
  readonly colorSpaceDetail = input<string | null>(null);
  readonly qualityVisible = input<boolean>(true);
  readonly sizeOptions = input<readonly MuiExportSizeOption[]>([]);
  readonly maxSidePixels = model<number>(0);
  readonly sizeHint = input<string | null>(null);

  readonly qualityText = computed(() => String(this.quality()));
  readonly sizeToggleOptions = computed<readonly MuiSegmentedToggleOption[]>(() =>
    this.sizeOptions().map((o) => ({ value: String(o.value), label: o.label })),
  );
  readonly sizeValueText = computed(() => String(this.maxSidePixels()));

  onQualityCommitted(raw: string): void {
    const parsed = Number.parseInt(raw, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : this.quality();
    this.quality.set(clamped);
  }

  onSizeChange(raw: string): void {
    const parsed = Number(raw);
    this.maxSidePixels.set(Number.isFinite(parsed) ? parsed : 0);
  }
}
