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
  DestroyRef,
  ElementRef,
  OnDestroy,
  inject,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  private readonly destroyRef = inject(DestroyRef);

  readonly mapContainerRef = viewChild.required<ElementRef<HTMLElement>>('mapContainer');

  /** Sticky for this mount — see `MapLibreService.tilesUnreachable`'s doc. */
  readonly tilesUnreachable = this.mapService.tilesUnreachable;

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
      .subscribe();
  }

  ngOnDestroy(): void {
    this.mapService.destroy();
  }
}
