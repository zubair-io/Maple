// ScopesPanelComponent — the editor's scopes surface (#2449, milestone 18
// design spec §2.4 / §3.2): mounts the Maple UI `mui-scopes-panel` organism
// (histogram · waveform · parade · vectorscope) over the render worker's
// per-frame scope readback, which `ImageCanvasComponent` already publishes
// as `ImageCanvasService.currentPixels` for the top-bar histogram. The
// reduction itself is the pure `scopeSampleFromPixels`; this component only
// wires the signal and the no-frame state (a GPU readback miss, or a mock
// asset with no decoded pixels) — the organism has no empty state of its
// own by design, so the caller says so instead of mounting it.

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ImageCanvasService } from '../image-canvas/image-canvas.service';
import { MuiScopesPanelComponent } from '../../ui/scopes-panel/mui-scopes-panel.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import { scopeSampleFromPixels } from './scope-sample';

/** Plot width inside the 240px glass panel (12px padding each side). */
const PLOT_WIDTH = 216;
const PLOT_HEIGHT = 48;

@Component({
  selector: 'editor-scopes-panel',
  standalone: true,
  imports: [MuiScopesPanelComponent, MuiTextComponent],
  templateUrl: './scopes-panel.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScopesPanelComponent {
  private readonly canvasSvc = inject(ImageCanvasService);

  protected readonly plotWidth = PLOT_WIDTH;
  protected readonly plotHeight = PLOT_HEIGHT;

  /** The four plots for the frame on screen, or `null` without a live frame. */
  readonly sample = computed(() => {
    const pixels = this.canvasSvc.currentPixels();
    return pixels ? scopeSampleFromPixels(pixels) : null;
  });
}
