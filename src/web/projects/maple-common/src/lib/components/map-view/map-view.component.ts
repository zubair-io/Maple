// MapViewComponent — the `map` browse viewMode surface (Map T3, #2827).
//
// Mounts a MapLibre map (via `MapLibreService`) into a plain `<div>` on
// `ngAfterViewInit`; the SDK itself never appears in this file or its
// template — see `MapLibreService`'s module doc. Pins/clustering (#2828)
// and the heatmap layer (#2829) are later tickets; this component's job is
// just getting a pannable/zoomable base map on screen, with an inline
// notice — not a blanked feature — when the configured tile source is
// unreachable (design doc § "Error / empty states").

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { MapLibreService } from '../../map/maplibre-map.service';

@Component({
  selector: 'app-map-view',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './map-view.component.html',
  styleUrl: './map-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapViewComponent implements AfterViewInit, OnDestroy {
  private readonly mapService = inject(MapLibreService);

  readonly mapContainerRef = viewChild.required<ElementRef<HTMLElement>>('mapContainer');

  /** Sticky for this mount — see `MapLibreService.tilesUnreachable`'s doc. */
  readonly tilesUnreachable = this.mapService.tilesUnreachable;

  ngAfterViewInit(): void {
    this.mapService.create(this.mapContainerRef().nativeElement).subscribe();
  }

  ngOnDestroy(): void {
    this.mapService.destroy();
  }
}
