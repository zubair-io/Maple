// ExportDialogComponent — export options for the focused image (#943).
//
// State machine: options → exporting → done | error.
//
// The parent binds [visible] and [asset] and listens for (dismiss); the dialog
// owns the whole flow, matching PanoDialogComponent.
//
// Chrome + focus-trap machinery now delegate entirely to `mui-export-modal`
// (#3046), extended with `phase` (the exact options → exporting → done →
// error state machine this file's own comments and discussion #2227
// establish — reproduced verbatim, not simplified into a lighter inline
// progress-bar shape) and the size/resolution picker `mui-export-modal`
// shipped without. `mui-overlay-shell` (which `mui-export-modal` is built
// on) already owns focus-on-open, Escape, Tab containment, and scrim-click
// dismiss generically — this wrapper's own job is purely the view-model
// (format/color-space/size choice tables + their blurbs, kept live as the
// user picks before submitting) and running the actual export against
// `ImageExportService`.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { Asset } from '../models/asset';
import type {
  ExportColorSpace,
  ExportFormat,
  RawExportOptions,
} from '../raw-pipeline/raw-pipeline.types';
import { ImageExportService, type ExportOutcome } from './image-export.service';
import {
  COLOR_SPACE_CHOICES,
  DEFAULT_QUALITY,
  FORMAT_CHOICES,
  SIZE_PRESETS,
  outputDimensions,
  supportsQuality,
} from './export-dialog.vm';
import { MuiExportModalComponent } from '../ui/export-modal/mui-export-modal.component';
import type {
  MuiExportModalPhase,
  MuiExportSettings,
  MuiExportSizeOption,
} from '../ui/export-modal/mui-export-modal.component';
import type { MuiSegmentedToggleOption } from '../ui/segmented-toggle/mui-segmented-toggle.component';

@Component({
  selector: 'app-export-dialog',
  standalone: true,
  imports: [MuiExportModalComponent],
  templateUrl: './export-dialog.component.html',
  styleUrl: './export-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExportDialogComponent {
  // ── inputs / outputs ───────────────────────────────────────────────────────
  readonly visible = input<boolean>(false);
  /** The image to export. `null` disables the confirm button. */
  readonly asset = input<Asset | null>(null);
  /** Emitted when the dialog should close (done, error, or user cancel). */
  readonly dismiss = output<void>();

  // ── services ───────────────────────────────────────────────────────────────
  private readonly exporter = inject(ImageExportService);

  // ── choice tables, translated to mui-segmented-toggle's string-value shape ─
  readonly formatOptions: readonly MuiSegmentedToggleOption[] = FORMAT_CHOICES.map((c) => ({
    value: c.value,
    label: c.label,
  }));
  readonly colorSpaceOptions: readonly MuiSegmentedToggleOption[] = COLOR_SPACE_CHOICES.map(
    (c) => ({ value: c.value, label: c.label }),
  );
  readonly sizeOptions: readonly MuiExportSizeOption[] = [
    // `value: 0` is the modal contract's "Full resolution" sentinel — it must
    // exist so the default (uncapped) state maps to a selectable option.
    { value: 0, label: 'Full resolution' },
    ...SIZE_PRESETS.map((px) => ({ value: px, label: `Long edge ${px} px` })),
  ];

  // ── state ─────────────────────────────────────────────────────────────────
  readonly phase = signal<MuiExportModalPhase>('options');
  readonly errorMessage = signal<string>('');
  readonly outcome = signal<ExportOutcome | null>(null);

  // ── option model ──────────────────────────────────────────────────────────
  readonly format = signal<ExportFormat>('jpeg');
  readonly quality = signal<number>(DEFAULT_QUALITY);
  readonly colorSpace = signal<ExportColorSpace>('srgb');
  /** `0` means full resolution; otherwise a long-edge cap in pixels. */
  readonly maxSidePixels = signal<number>(0);

  readonly qualityVisible = computed(() => supportsQuality(this.format()));

  /**
   * The blurb shown under each picker for whichever option is selected.
   *
   * Resolved here rather than by scanning the choice table in the template —
   * the lookup is a view-model rule, threaded into `mui-export-modal` as a
   * plain string input.
   */
  readonly formatDetail = computed(
    () => FORMAT_CHOICES.find((choice) => choice.value === this.format())?.detail ?? '',
  );

  readonly colorSpaceDetail = computed(
    () => COLOR_SPACE_CHOICES.find((choice) => choice.value === this.colorSpace())?.detail ?? '',
  );

  /** The pixel dimensions of the file that was just written, for the done pane. */
  readonly outcomeSize = computed(() => {
    const result = this.outcome();
    return result ? `${result.width} × ${result.height} px` : '';
  });

  readonly doneMessage = computed(() => {
    const result = this.outcome();
    return result ? `Exported ${result.filename}` : null;
  });

  /**
   * The line under the size picker.
   *
   * Until the native dimensions are known the summary can only state the rule;
   * once they are, it states the exact pixels the export will produce.
   */
  readonly sizeHint = computed(() => {
    const asset = this.asset();
    const size = outputDimensions(asset?.width ?? 0, asset?.height ?? 0, this.maxSidePixels());
    return size.width > 0 && size.height > 0
      ? `Output: ${size.width} × ${size.height} px. Never upscales.`
      : 'Never upscales beyond the original resolution.';
  });

  constructor() {
    // Reset back to a fresh options form each time the dialog is opened, so a
    // previous run's error or success banner never greets the next export.
    effect(() => {
      if (!this.visible()) return;
      this.phase.set('options');
      this.errorMessage.set('');
      this.outcome.set(null);
    });
  }

  onFormatChange(value: string): void {
    this.format.set(value as ExportFormat);
  }

  onColorSpaceChange(value: string): void {
    this.colorSpace.set(value as ExportColorSpace);
  }

  onQualityChange(value: number): void {
    this.quality.set(value);
  }

  onMaxSidePixelsChange(value: number): void {
    this.maxSidePixels.set(value);
  }

  async onExportRequested(settings: MuiExportSettings): Promise<void> {
    const asset = this.asset();
    if (!asset || this.phase() === 'exporting') return;

    const options: RawExportOptions = {
      format: settings.format as ExportFormat,
      quality: settings.quality,
      colorSpace: settings.colorSpace as ExportColorSpace,
      // 0 is the "native resolution" sentinel the pipeline expects.
      maxSidePixels: settings.maxSidePixels || undefined,
    };

    this.phase.set('exporting');
    try {
      this.outcome.set(await this.exporter.exportAsset(asset, options));
      this.phase.set('done');
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
      this.phase.set('error');
    }
  }

  onDismissed(): void {
    if (this.phase() === 'exporting') return;
    this.dismiss.emit();
  }

  onRetry(): void {
    this.phase.set('options');
    this.errorMessage.set('');
  }
}
