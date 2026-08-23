// MuiPageTvMap — Maple UI Pages (unified-component-catalog.md §6). Tab
// Shell switching Content's Map Surface between a plain pin view ("Map"
// tab) and a density overlay ("Density" tab).
//
// Cross-organism wiring: the Tab Shell's active tab drives the Map
// Surface's `heatmapVisible` — and toggling the heatmap directly on the Map
// Surface (its own built-in control) switches the active tab back, so the
// two stay in lockstep in either direction. Selecting a pin updates a
// caption line below the map.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiTabShellComponent } from '../../tab-shell/mui-tab-shell.component';
import type { MuiTab } from '../../tabs/mui-tabs.component';
import { MuiTextComponent } from '../../text/mui-text.component';
import { MuiMapSurfaceComponent } from '../../map-surface/mui-map-surface.component';
import type { MuiMapAnnotationInput } from '../../map-surface/mui-map-surface.component';

const ANNOTATIONS: readonly MuiMapAnnotationInput[] = [
  { id: 'm1', x: 0.28, y: 0.35, label: 'Ballet Session' },
  { id: 'm2', x: 0.3, y: 0.37, label: 'Studio B' },
  { id: 'm3', x: 0.72, y: 0.6, label: 'Coastal Shoot' },
];

@Component({
  selector: 'mui-page-tv-map',
  standalone: true,
  imports: [MuiTabShellComponent, MuiTextComponent, MuiMapSurfaceComponent],
  templateUrl: './mui-page-tv-map.component.html',
  styleUrl: './mui-page-tv-map.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageTvMapComponent {
  readonly tabs: readonly MuiTab[] = [
    { id: 'map', label: 'Map' },
    { id: 'density', label: 'Density' },
  ];
  readonly activeTabId = signal<string>('map');

  readonly annotations = ANNOTATIONS;
  readonly selectedAnnotationId = signal<string | null>(null);

  readonly heatmapVisible = computed<boolean>(() => this.activeTabId() === 'density');

  readonly caption = computed<string>(() => {
    const id = this.selectedAnnotationId();
    const annotation = ANNOTATIONS.find((a) => a.id === id);
    return annotation?.label ?? 'Select a pin to see its location.';
  });

  onHeatmapToggled(visible: boolean): void {
    this.activeTabId.set(visible ? 'density' : 'map');
  }

  onAnnotationSelected(id: string): void {
    this.selectedAnnotationId.set(id);
  }
}
