// MuiExportModal — Maple UI Organisms (unified-component-catalog.md §4.4).
// Format/size/quality/color-space export dialog, built from Overlay Shell,
// Segmented Toggle (format/color-space/size pickers), Form Field (quality),
// Progress, and Banner. Presentational: the host owns the export request
// lifecycle and feeds phase/progress/outcome back in as the job runs.
//
// Two ways to report an in-flight/finished export, chosen by whether the
// caller sets `phase` (#3046):
//  - Leave `phase` at its default `'options'` and drive `exporting` +
//    `resultBanner` instead — a lightweight inline progress bar/banner
//    appended below the still-visible options form. The showcase's demo
//    export uses this shape.
//  - Set `phase` to `'exporting'`/`'done'`/`'error'` for the Pro Editor's
//    original 4-phase state machine: each phase is its OWN dedicated pane
//    (header/body/footer all swap), not an inline addition to the options
//    form — `exportDialog.component.ts`'s reviewed structure (see that
//    file's own comments + discussion #2227), reproduced here rather than
//    folded into the lighter inline-banner shape.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import type { MuiBannerVariant } from '../banner/mui-banner.component';
import { MuiBannerComponent } from '../banner/mui-banner.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import type { MuiSegmentedToggleOption } from '../segmented-toggle/mui-segmented-toggle.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiExportOptionsFieldsComponent } from './mui-export-options-fields.component';

export type MuiExportModalPhase = 'options' | 'exporting' | 'done' | 'error';

export interface MuiExportSettings {
  readonly format: string;
  readonly quality: number;
  readonly colorSpace: string;
  /** `0` (or omitted) means full resolution — a long-edge cap otherwise. */
  readonly maxSidePixels?: number;
}

export interface MuiExportResultBanner {
  readonly message: string;
  readonly variant: MuiBannerVariant;
}

/** A selectable long-edge cap; `value: 0` is "Full resolution". */
export interface MuiExportSizeOption {
  readonly value: number;
  readonly label: string;
}

@Component({
  selector: 'mui-export-modal',
  standalone: true,
  imports: [
    MuiBannerComponent,
    MuiButtonComponent,
    MuiExportOptionsFieldsComponent,
    MuiOverlayShellComponent,
    MuiProgressComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-export-modal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
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

  // ── #3046: 4-phase state machine + size picker + choice blurbs ─────────

  /** Drives the dedicated exporting/done/error panes below. Stays
   * `'options'` for a caller using the lighter `exporting`/`resultBanner`
   * inline shape instead. */
  readonly phase = input<MuiExportModalPhase>('options');
  /** Blurb shown under the format picker for whichever choice is selected
   * — a view-model rule the caller resolves (mirrors `formatDetail()` in
   * `export-dialog.component.ts`), not a lookup this presentational
   * organism performs on the caller's choice table itself. */
  readonly formatDetail = input<string | null>(null);
  readonly colorSpaceDetail = input<string | null>(null);
  /** Hides the Quality field entirely — lossless formats have no quality
   * knob (only JPEG does in the Pro Editor's own table). */
  readonly qualityVisible = input<boolean>(true);
  /** Long-edge presets offered alongside "Full resolution" (`value: 0`).
   * Empty (the default) hides the Size field — a caller with no size
   * concept at all (the showcase demo) never gets an empty picker. */
  readonly sizeOptions = input<readonly MuiExportSizeOption[]>([]);
  readonly maxSidePixels = model<number>(0);
  /** The line under the Size picker — the exact output pixels once known,
   * same "view-model rule" reasoning as `formatDetail`. */
  readonly sizeHint = input<string | null>(null);
  readonly exportDisabled = input<boolean>(false);

  /** `phase: 'exporting'` pane copy. */
  readonly exportingMessage = input<string>('Exporting…');
  readonly exportingDetail = input<string | null>(null);
  /** `phase: 'done'` pane copy. */
  readonly doneMessage = input<string | null>(null);
  readonly doneDetail = input<string | null>(null);
  /** `phase: 'error'` pane copy. */
  readonly errorDetail = input<string | null>(null);

  /** Fires with the current settings when Export is pressed. */
  readonly exportRequested = output<MuiExportSettings>();
  /** Fires on Cancel, Escape, or an outside click — Escape/scrim-click are
   * suppressed while `phase() === 'exporting'`, the same busy guard the
   * legacy dialog's own Escape handler and backdrop click applied. */
  readonly dismissed = output<void>();
  /** `phase: 'error'` pane's "Try again" action — returns to the options
   * form without discarding the caller's chosen settings. */
  readonly retryRequested = output<void>();

  confirmExport(): void {
    this.exportRequested.emit({
      format: this.format(),
      quality: this.quality(),
      colorSpace: this.colorSpace(),
      maxSidePixels: this.maxSidePixels() || undefined,
    });
  }

  /** Routed through the overlay's own Escape/scrim-click `dismissed` —
   * suppressed mid-export the same way the footer's own Cancel button is
   * never rendered for that phase. */
  onOverlayDismissed(): void {
    if (this.phase() === 'exporting') return;
    this.dismissed.emit();
  }
}
