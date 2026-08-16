// MapViewComponent — the `map` browse viewMode surface (Map T3 #2827, pins
// added in Map T4 #2828, heatmap added in Map T5 #2829).
//
// Mounts a MapLibre map (via `MapLibreService`) into a plain `<div>` on
// `ngAfterViewInit`; the SDK itself never appears in this file or its
// template — see `MapLibreService`'s module doc. Once the map instance
// exists, `MapHeatmapLayerService` attaches its density-overlay layer first,
// then `MapClusterPinsService` (both provided here, component-scoped, so
// their state lives and dies with this one mount) attaches and owns the
// clustered pins/count-bubbles layer — see each service's module doc.
// Heatmap-before-pins is a deliberate ordering, not just declaration order:
// it keeps the heatmap layer underneath anything pins add to the map's own
// layer stack, which is what "heatmap renders beneath the pins" actually
// means for a canvas layer (today's DOM `Marker` pins already render above
// the canvas regardless of order, per the SDK). This component's other job
// is showing an inline notice — never a blanked feature — when the
// configured tile source is unreachable, or when the viewport has no
// located photos (design doc § "Error / empty states").

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  inject,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MapClusterPinsService } from '../../map/map-cluster-pins.service';
import { MapHeatmapLayerService } from '../../map/map-heatmap-layer.service';
import { MapLibreService } from '../../map/maplibre-map.service';

@Component({
  selector: 'app-map-view',
  standalone: true,
  imports: [RouterLink],
  providers: [MapClusterPinsService, MapHeatmapLayerService],
  templateUrl: './map-view.component.html',
  styleUrl: './map-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapViewComponent implements AfterViewInit, OnDestroy {
  private readonly mapService = inject(MapLibreService);
  private readonly pins = inject(MapClusterPinsService);
  private readonly heatmap = inject(MapHeatmapLayerService);
  private readonly destroyRef = inject(DestroyRef);

  readonly mapContainerRef = viewChild.required<ElementRef<HTMLElement>>('mapContainer');

  /** Sticky for this mount — see `MapLibreService.tilesUnreachable`'s doc. */
  readonly tilesUnreachable = this.mapService.tilesUnreachable;

  /** True once the current viewport's fetch resolved with zero located
   * photos — see `MapClusterPinsService.empty`'s doc. */
  readonly noLocatedPhotos = this.pins.empty;

  ngAfterViewInit(): void {
    // `create()` resolves the tile-source config over the network before it
    // mounts anything, so a viewMode switch can destroy this component with
    // that fetch still in flight. Without this teardown the late emission
    // mounts a map onto a detached container and strands the handle in
    // `MapLibreService` — which is `providedIn: 'root'`, so nothing would ever
    // `destroy()` it and the WebGL context leaks for the session.
    this.mapService
      .create(this.mapContainerRef().nativeElement)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        const handle = this.mapService.currentHandle();
        if (!handle) return;
        this.heatmap.attach(handle);
        this.pins.attach(handle);
      });
  }

  ngOnDestroy(): void {
    this.pins.detach();
    this.mapService.destroy();
  }
}
