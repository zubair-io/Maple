// ExportDialogComponent — export options for the focused image (#943).
//
// State machine: options → exporting → done | error.
//
// The parent binds [visible] and [asset] and listens for (dismiss); the dialog
// owns the whole flow, matching PanoDialogComponent.

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

type DialogPhase = 'options' | 'exporting' | 'done' | 'error';

@Component({
  selector: 'app-export-dialog',
  standalone: true,
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

  // ── static choice tables (read by the template) ───────────────────────────
  readonly formatChoices = FORMAT_CHOICES;
  readonly colorSpaceChoices = COLOR_SPACE_CHOICES;
  readonly sizePresets = SIZE_PRESETS;

  // ── state ─────────────────────────────────────────────────────────────────
  readonly phase = signal<DialogPhase>('options');
  readonly errorMessage = signal<string>('');
  readonly outcome = signal<ExportOutcome | null>(null);

  // ── option model ──────────────────────────────────────────────────────────
  readonly format = signal<ExportFormat>('jpeg');
  readonly quality = signal<number>(DEFAULT_QUALITY);
  readonly colorSpace = signal<ExportColorSpace>('srgb');
  /** `0` means full resolution; otherwise a long-edge cap in pixels. */
  readonly maxSidePixels = signal<number>(0);

  readonly qualityVisible = computed(() => supportsQuality(this.format()));
  readonly busy = computed(() => this.phase() === 'exporting');

  /**
   * The blurb shown under each picker for whichever option is selected.
   *
   * Resolved here rather than by scanning the choice table in the template —
   * the lookup is a view-model rule, and the template stays a flat rendering
   * of the current state.
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
      if (this.visible()) {
        this.phase.set('options');
        this.errorMessage.set('');
        this.outcome.set(null);
      }
    });
  }

  onFormatChange(value: string): void {
    this.format.set(value as ExportFormat);
  }

  onColorSpaceChange(value: string): void {
    this.colorSpace.set(value as ExportColorSpace);
  }

  onQualityChange(value: string): void {
    const parsed = Number(value);
    this.quality.set(
      Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : DEFAULT_QUALITY,
    );
  }

  onSizeChange(value: string): void {
    const parsed = Number(value);
    this.maxSidePixels.set(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
  }

  async onExport(): Promise<void> {
    const asset = this.asset();
    if (!asset || this.busy()) return;

    const options: RawExportOptions = {
      format: this.format(),
      quality: this.quality(),
      colorSpace: this.colorSpace(),
      // 0 is the "native resolution" sentinel the pipeline expects.
      maxSidePixels: this.maxSidePixels() || undefined,
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

  onBackdropClick(): void {
    if (!this.busy()) this.dismiss.emit();
  }

  onClose(): void {
    if (!this.busy()) this.dismiss.emit();
  }

  onRetry(): void {
    this.phase.set('options');
    this.errorMessage.set('');
  }
}
