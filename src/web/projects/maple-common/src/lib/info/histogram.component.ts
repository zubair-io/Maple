// InfoHistogramComponent — S6 Info content section 2 (web).
//
// Renders three overlaid RGB line plots as inline SVG polylines, sourced in
// priority order: (1) live local pixels — the editor canvas publishes a decoded
// snapshot to `ImageCanvasService.currentPixels`, which we bin on device so the
// histogram works for local (non-server) files and updates with every edit; or
// (2) the server-computed histogram from `GET /api/assets/:id/histogram` (#633)
// for Browse mode / before the canvas has decoded. Falls back to the decorative
// placeholder when neither is available — including on any fetch error
// (network, 4xx, 5xx, or the 503 the server returns when libraw_ffi is down).
//
// Why line plots, not filled stacked bars: at 56px tall the typical
// histogram has too few vertical pixels to read stacks; overlapping
// thin lines (`stroke-width=1, opacity=0.7`) keep all three channels
// legible even when two overlap closely.
//
// Why SVG over Canvas: the SVG payload for 3×256-bin polylines is
// ~6 KB raw, GZIPs to <2 KB, and is fully accessible to AT in the
// DOM. Canvas would need a separate ARIA description anyway. The
// equivalent Apple block uses `SwiftUI.Canvas` for the same shape —
// platform-idiomatic on each side.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { catchError, of } from 'rxjs';
import type { Asset } from '../models/asset';
import type { ApiHistogram } from '../api/bun-api-backend.service';
import { ImageCanvasService } from '../components/image-canvas/image-canvas.service';
import { computeRgbHistograms } from '../raw-pipeline/image-utils';
import { SERVER_LIBRARY_IO } from '../workspace/server-library-io';

@Component({
  selector: 'app-info-histogram',
  standalone: true,
  templateUrl: './histogram.component.html',
  styleUrl: './histogram.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-histogram',
  },
})
export class InfoHistogramComponent {
  private readonly serverIo = inject(SERVER_LIBRARY_IO, { optional: true });
  private readonly canvas = inject(ImageCanvasService);

  readonly asset = input<Asset | null>(null);

  /** Server-computed histogram (fallback), or null when not yet loaded /
   *  failed / no asset. The live local path below takes precedence. */
  readonly histogram = signal<ApiHistogram | null>(null);

  /** Polyline `points` strings for each channel. Source priority:
   *    1. Live local pixels — the editor canvas publishes a decoded snapshot
   *       to `ImageCanvasService.currentPixels`; binning it here makes the
   *       histogram work for local (non-server) files AND update with every
   *       edit, with no server round-trip.
   *    2. The server-computed histogram (Browse mode, or before the canvas
   *       has decoded).
   *  Null when neither is available, which short-circuits the template back
   *  to the decorative placeholder. */
  readonly polylines = computed(() => {
    // Only source from live local pixels when an asset is actually bound — the
    // canvas service may still hold a previous image's snapshot, and the
    // contract is: no asset ⇒ placeholder.
    const px = this.asset() ? this.canvas.currentPixels() : null;
    if (px) {
      const { r, g, b } = computeRgbHistograms(px);
      return { r: toPolylinePoints(r), g: toPolylinePoints(g), b: toPolylinePoints(b) };
    }
    const h = this.histogram();
    if (!h) return null;
    return {
      r: toPolylinePoints(h.r),
      g: toPolylinePoints(h.g),
      b: toPolylinePoints(h.b),
    };
  });

  constructor() {
    // Refetch whenever the bound asset changes. The reactive read inside
    // the `effect` re-binds the signal automatically. The `untracked`
    // boundary isn't needed here — we WANT to refetch when the asset
    // changes, and the request lifecycle is contained in the subscribe.
    effect((onCleanup) => {
      const a = this.asset();
      this.histogram.set(null);
      if (!a?.id || !this.serverIo) return;
      const sub = this.serverIo
        .getHistogram(a.id)
        .pipe(
          catchError(() => {
            // Network / 4xx / 5xx — fall back to the placeholder. The
            // 503 path (dylib unavailable on the server) lands here.
            return of(null);
          }),
        )
        .subscribe((h) => {
          this.histogram.set(h);
        });
      onCleanup(() => sub.unsubscribe());
    });
  }
}

/**
 * Build an SVG `points` attribute for one channel — `viewBox` is
 * `0 0 256 100`, so x = bin index and y = 100 * (1 - normalised count).
 *
 * Normalisation is per-channel by max so the curve fills the box
 * regardless of pixel count. A flat-zero channel renders as the
 * baseline (y = 100); the `?? 1` guard is a defensive no-op for that
 * shape so we don't divide by zero.
 */
function toPolylinePoints(bins: ArrayLike<number>): string {
  let max = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i] > max) max = bins[i];
  const denom = max > 0 ? max : 1;
  const out: string[] = [];
  for (let i = 0; i < bins.length; i++) {
    const y = 100 - (bins[i] / denom) * 100;
    out.push(`${i},${y.toFixed(2)}`);
  }
  return out.join(' ');
}
