// MuiPageEditor — Maple UI Pages (unified-component-catalog.md §6). Split
// Layout: a narrow Tool Dock sidebar, a Center region stacking Image
// Canvas + Control Surface + Filmstrip, and a Detail region hosting the
// Inspector Panel (with the Adjustments Panel projected inside it).
//
// Cross-organism wiring:
//  - Tool Dock selection swaps which tab the Control Surface shows.
//  - A Control Surface (or Adjustments Panel) slider change updates a
//    Value HUD readout over the canvas — the scenario named directly in
//    the W7 brief.
//  - Selecting a Filmstrip frame swaps the Image Canvas's source photo.

import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MuiSplitLayoutComponent } from '../../split-layout/mui-split-layout.component';
import { MuiToolDockComponent } from '../../tool-dock/mui-tool-dock.component';
import type { MuiToolDockEntry } from '../../tool-dock/mui-tool-dock.component';
import { MuiImageCanvasComponent } from '../../image-canvas/mui-image-canvas.component';
import { MuiControlSurfaceComponent } from '../../control-surface/mui-control-surface.component';
import type { MuiControlSurfaceSlider } from '../../control-surface/mui-control-surface.component';
import { MuiFilmstripComponent } from '../../filmstrip/mui-filmstrip.component';
import type { MuiFilmstripItem } from '../../filmstrip-row/mui-filmstrip-row.component';
import { MuiInspectorPanelComponent } from '../../inspector-panel/mui-inspector-panel.component';
import { MuiAdjustmentsPanelComponent } from '../../adjustments-panel/mui-adjustments-panel.component';
import type { MuiAdjustmentTab } from '../../adjustments-panel/mui-adjustments-panel.component';
import { MuiValueHudComponent } from '../../value-hud/mui-value-hud.component';
import type { MuiTab } from '../../tabs/mui-tabs.component';
import { pageLandscape } from '../internal/mock-media';

@Component({
  selector: 'mui-page-editor',
  standalone: true,
  imports: [
    MuiSplitLayoutComponent,
    MuiToolDockComponent,
    MuiImageCanvasComponent,
    MuiControlSurfaceComponent,
    MuiFilmstripComponent,
    MuiInspectorPanelComponent,
    MuiAdjustmentsPanelComponent,
    MuiValueHudComponent,
  ],
  templateUrl: './mui-page-editor.component.html',
  styleUrl: './mui-page-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageEditorComponent {
  readonly toolDockEntries: readonly MuiToolDockEntry[] = [
    { id: 'light', icon: 'droplet', label: 'Light' },
    { id: 'color', icon: 'eyedrop', label: 'Color' },
    { divider: true },
    { id: 'crop', icon: 'split', label: 'Crop' },
  ];
  readonly toolDockActiveId = signal<string | null>('light');

  readonly controlSurfaceTabs: readonly MuiTab[] = [
    { id: 'light', label: 'Light' },
    { id: 'color', label: 'Color' },
    { id: 'crop', label: 'Crop' },
  ];
  readonly controlSurfaceActiveTab = signal<string>('light');
  readonly controlSurfaceSliders = signal<readonly MuiControlSurfaceSlider[]>([
    { id: 'exposure', label: 'Exposure', value: 0.3, min: -5, max: 5, step: 0.1, unit: 'EV' },
    { id: 'contrast', label: 'Contrast', value: 12, min: -100, max: 100, step: 1, unit: '' },
  ]);

  readonly adjustmentTabs: readonly MuiAdjustmentTab[] = [
    {
      id: 'basic',
      label: 'Basic',
      groups: [
        {
          id: 'basic-sliders',
          label: 'Basic',
          sliders: [
            { id: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.1, bipolar: true },
            { id: 'contrast', label: 'Contrast', min: -100, max: 100, bipolar: true },
            { id: 'shadows', label: 'Shadows', min: -100, max: 100, bipolar: true },
            { id: 'vibrance', label: 'Vibrance', min: -100, max: 100, bipolar: true },
          ],
        },
      ],
    },
    {
      id: 'crop',
      label: 'Crop',
      groups: [
        {
          id: 'geometry',
          label: 'Geometry',
          sliders: [
            {
              id: 'angle',
              label: 'Straighten',
              min: -45,
              max: 45,
              step: 0.5,
              unit: '°',
              bipolar: true,
            },
          ],
        },
      ],
    },
  ];
  readonly adjustmentValues = signal<Readonly<Record<string, number>>>({
    exposure: 0.3,
    contrast: 12,
    shadows: 15,
    vibrance: 10,
    angle: 0,
  });
  readonly adjustmentsActiveTabId = signal<string>('basic');

  readonly inspectorTabs: readonly MuiTab[] = [
    { id: 'develop', label: 'Develop' },
    { id: 'info', label: 'Info' },
  ];
  readonly inspectorActiveTabId = signal<string>('develop');

  private readonly frames = [pageLandscape(0), pageLandscape(1), pageLandscape(2)] as const;
  readonly filmstripItems: readonly MuiFilmstripItem[] = this.frames.map((src, i) => ({
    id: `frame-${i}`,
    src,
    alt: `Frame ${i + 1}`,
  }));
  readonly filmstripActiveId = signal<string | null>('frame-0');
  readonly canvasSrc = signal<string>(this.frames[0]);

  readonly hudLabel = signal<string>('');
  readonly hudValue = signal<string>('');
  readonly hudVisible = signal<boolean>(false);

  onToolSelected(id: string | null): void {
    this.toolDockActiveId.set(id);
    if (id !== null && this.controlSurfaceTabs.some((tab) => tab.id === id)) {
      this.controlSurfaceActiveTab.set(id);
    }
  }

  onControlSliderChanged(change: { id: string; value: number }): void {
    this.controlSurfaceSliders.update((sliders) =>
      sliders.map((slider) =>
        slider.id === change.id ? { ...slider, value: change.value } : slider,
      ),
    );
    this.showHud(change.id, change.value);
  }

  onControlSliderReset(id: string): void {
    this.onControlSliderChanged({ id, value: 0 });
  }

  onAdjustmentValueChanged(change: { sliderId: string; value: number }): void {
    this.adjustmentValues.update((values) => ({ ...values, [change.sliderId]: change.value }));
    this.showHud(change.sliderId, change.value);
  }

  onAdjustmentSliderReset(sliderId: string): void {
    this.onAdjustmentValueChanged({ sliderId, value: 0 });
  }

  private showHud(label: string, value: number): void {
    this.hudLabel.set(label);
    this.hudValue.set(value.toFixed(1));
    this.hudVisible.set(true);
  }

  onFilmstripActivated(id: string | null): void {
    this.filmstripActiveId.set(id);
    const index = this.filmstripItems.findIndex((item) => item.id === id);
    if (index >= 0) this.canvasSrc.set(this.frames[index]);
  }
}
