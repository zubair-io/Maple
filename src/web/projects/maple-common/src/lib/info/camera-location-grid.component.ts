// CameraLocationGridComponent — S6 Info content section 3 (web).
//
// 2-column label/value grid backed by the Asset model's EXIF / GPS
// fields (camera, lens, aperture, shutter, iso, focal, gps, city).
// Missing fields render as "—" so the row count is constant regardless
// of the image.
//
// Body folds camera + nothing (model isn't a separate field on the web
// model; the `camera` field already carries the full descriptor).
// Coords prefers the structured `gps: { lat, lon }` over textual labels.
// City uses the existing `asset.city` (server-side reverse-geocode on
// Self Hosted; absent on Hosted — renders as "—").

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { Asset } from '../models/asset';

interface KvRow {
  id: string;
  label: string;
  value: string;
}

@Component({
  selector: 'app-camera-location-grid',
  standalone: true,
  templateUrl: './camera-location-grid.component.html',
  styleUrl: './camera-location-grid.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-camera-location',
  },
})
export class CameraLocationGridComponent {
  readonly asset = input<Asset | null>(null);

  protected readonly rows = computed<KvRow[]>(() =>
    CameraLocationGridComponent.rowsFor(this.asset()),
  );

  /** Pure projection — exported as a static so the spec can exercise it
   * directly without setting up the TestBed. */
  static rowsFor(a: Asset | null): KvRow[] {
    return [
      { id: 'body', label: 'Body', value: a?.camera ?? '—' },
      { id: 'lens', label: 'Lens', value: a?.lens ?? '—' },
      { id: 'aperture', label: 'Aperture', value: a?.aperture ?? '—' },
      { id: 'shutter', label: 'Shutter', value: a?.shutter ?? '—' },
      { id: 'iso', label: 'ISO', value: a?.iso !== undefined ? String(a.iso) : '—' },
      { id: 'focal', label: 'Focal', value: a?.focalLength ?? '—' },
      {
        id: 'coords',
        label: 'Coords',
        value: a?.gps ? `${a.gps.lat.toFixed(4)}, ${a.gps.lon.toFixed(4)}` : '—',
      },
      { id: 'city', label: 'City', value: a?.city ?? '—' },
    ];
  }
}
