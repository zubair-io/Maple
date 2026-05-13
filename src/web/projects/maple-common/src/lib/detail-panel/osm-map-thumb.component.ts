// Small OpenStreetMap tile thumbnail with a pin at the exact (lat, lon).
// Extracted from InfoTabComponent so the slippy-map math + the
// open-in-maps anchor live in one focused place. The thumb opens
// openstreetmap.org centered on the point when clicked.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const MAP_ZOOM = 13;
const MAX_LAT = 85.05112877980659;

/** Clamp lat to the WebMercator-defined band and wrap lon into
 * [-180, 180). Without this, lat near ±90 collapses to NaN/Infinity
 * (cos(π/2) ≈ 0 in the y formula) and lon ≥ 180 lands at x = 2^z
 * which is one past the valid range — both produce 404 tiles. */
function normalizeLatLon(lat: number, lon: number): { lat: number; lon: number } {
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const wrappedLon = (((lon + 180) % 360) + 360) % 360 - 180;
    return { lat: clampedLat, lon: wrappedLon };
}

/** OSM raster tile URL for the slippy-map tile that *contains* (lat, lon).
 * Standard math from https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames.
 * Zoom is fixed at MAP_ZOOM so the tile and the pin (`pinOffsetPct`) stay
 * in lockstep — a parameterised zoom on the tile without the same zoom on
 * the pin lands the pin in the wrong spot. */
export function staticMapTileUrl(lat: number, lon: number): string {
    const { lat: nLat, lon: nLon } = normalizeLatLon(lat, lon);
    const z = MAP_ZOOM;
    const n = Math.pow(2, z);
    const xRaw = Math.floor(((nLon + 180) / 360) * n);
    const latRad = (nLat * Math.PI) / 180;
    const yRaw = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
    );
    const x = Math.max(0, Math.min(n - 1, xRaw));
    const y = Math.max(0, Math.min(n - 1, yRaw));
    return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

/** CSS left/top percentages so the pin sits on the actual lat/lon
 * inside the rendered tile. Same slippy-map math, fractional part. */
export function pinOffsetPct(lat: number, lon: number): { left: string; top: string } {
    const { lat: nLat, lon: nLon } = normalizeLatLon(lat, lon);
    const n = Math.pow(2, MAP_ZOOM);
    const xFrac = ((nLon + 180) / 360) * n;
    const latRad = (nLat * Math.PI) / 180;
    const yFrac =
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const left = (xFrac - Math.floor(xFrac)) * 100;
    const top = (yFrac - Math.floor(yFrac)) * 100;
    return { left: `${left.toFixed(2)}%`, top: `${top.toFixed(2)}%` };
}

/** External "open in maps" URL — the OSM web viewer with a marker. */
export function openInMapsUrl(lat: number, lon: number): string {
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
}

@Component({
    selector: 'maple-osm-map-thumb',
    standalone: true,
    imports: [],
    templateUrl: './osm-map-thumb.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OsmMapThumbComponent {
    lat = input.required<number>();
    lon = input.required<number>();

    readonly mapUrl = computed(() => openInMapsUrl(this.lat(), this.lon()));
    readonly tileUrl = computed(() => staticMapTileUrl(this.lat(), this.lon()));
    readonly pin = computed(() => pinOffsetPct(this.lat(), this.lon()));
    readonly title = computed(
        () => `Open in OpenStreetMap (${this.lat().toFixed(4)}, ${this.lon().toFixed(4)})`,
    );
    readonly alt = computed(() => `Map of ${this.lat().toFixed(4)}, ${this.lon().toFixed(4)}`);
}
