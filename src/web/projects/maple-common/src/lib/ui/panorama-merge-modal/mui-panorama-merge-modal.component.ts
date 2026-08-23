// MuiPanoramaMergeModal — Maple UI Organisms (unified-component-catalog.md
// §4.4). Stitch options and progress, built from Overlay Shell, Segmented
// Toggle (projection + blend mode), Progress, and Media Cell (repeated
// source-frame thumbnails). Projection/blend-mode option sets are fixed —
// they're intrinsic to what the stitcher supports, not host data.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiMediaCellComponent } from '../media-cell/mui-media-cell.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiProgressComponent } from '../progress/mui-progress.component';
import type { MuiSegmentedToggleOption } from '../segmented-toggle/mui-segmented-toggle.component';
import { MuiSegmentedToggleComponent } from '../segmented-toggle/mui-segmented-toggle.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiPanoramaFrame {
  readonly id: string;
  readonly src: string;
  readonly alt: string;
}

export interface MuiPanoramaMergeSettings {
  readonly projection: string;
  readonly blendMode: string;
}

const PROJECTION_OPTIONS: readonly MuiSegmentedToggleOption[] = [
  { value: 'spherical', label: 'Spherical' },
  { value: 'cylindrical', label: 'Cylindrical' },
  { value: 'perspective', label: 'Perspective' },
];

const BLEND_MODE_OPTIONS: readonly MuiSegmentedToggleOption[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'multi-band', label: 'Multi-band' },
];

@Component({
  selector: 'mui-panorama-merge-modal',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiMediaCellComponent,
    MuiOverlayShellComponent,
    MuiProgressComponent,
    MuiSegmentedToggleComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-panorama-merge-modal.component.html',
  styleUrl: './mui-panorama-merge-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPanoramaMergeModalComponent {
  readonly open = input<boolean>(false);
  readonly frames = input.required<readonly MuiPanoramaFrame[]>();
  readonly projection = model<string>('spherical');
  readonly blendMode = model<string>('linear');
  readonly stitching = input<boolean>(false);
  /** 0–100, ignored while `stitching` is false. */
  readonly progress = input<number>(0);

  readonly mergeRequested = output<MuiPanoramaMergeSettings>();
  readonly dismissed = output<void>();

  readonly projectionOptions = PROJECTION_OPTIONS;
  readonly blendModeOptions = BLEND_MODE_OPTIONS;

  confirmMerge(): void {
    this.mergeRequested.emit({ projection: this.projection(), blendMode: this.blendMode() });
  }
}
