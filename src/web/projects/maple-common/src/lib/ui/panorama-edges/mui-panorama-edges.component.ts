// MuiPanoramaEdges — the "Edges" group of the panorama merge options: a
// Boundary Warp slider and an Auto Crop toggle (epic #5570, slice f). One
// implementation for the web pano dialog and mui-panorama-merge-modal. The
// host owns the engine report: it passes the reason line, and re-runs its
// preview on `warpCommit` (once per drag) and on every Auto Crop change.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiSliderComponent } from '../slider/mui-slider.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiToggleComponent } from '../toggle/mui-toggle.component';
import { AUTO_CROP_HELP, BOUNDARY_WARP_HELP } from './pano-edges-reason';

let nextEdgesId = 0;

@Component({
  selector: 'mui-panorama-edges',
  standalone: true,
  imports: [MuiSliderComponent, MuiTextComponent, MuiToggleComponent],
  templateUrl: './mui-panorama-edges.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPanoramaEdgesComponent {
  /** Requested Boundary Warp in percent; follows the thumb while dragging. */
  readonly boundaryWarp = model<number>(0);
  readonly autoCrop = model<boolean>(false);
  /** Why the warp did not take effect as asked; replaces the muted help while set. */
  readonly reason = input<string | null>(null);
  readonly disabled = input<boolean>(false);

  /** The final Boundary Warp value once a drag or key press ends. */
  readonly warpCommit = output<number>();

  private readonly id = nextEdgesId++;
  readonly cropHelpId = `mui-panorama-edges-crop-help-${this.id}`;
  readonly cropHelp = AUTO_CROP_HELP;
  readonly warpHelper = computed(() => this.reason() ?? BOUNDARY_WARP_HELP);
}
