// InfoHistogramComponent — S6 Info content section 2 (web).
//
// v0.1 PLACEHOLDER. Spec calls for a server-rendered RGB curves SVG/PNG
// fetched from the API; the endpoint does not exist yet in `src/api/`
// (audited 2026-05-29 — no `/histogram/:assetId` route). Follow-up ticket:
// "API: server-rendered RGB histogram endpoint for InfoPanel".
//
// Until that lands we render a 56px-tall surface block with three faint
// Gaussian humps (red/green/blue) so the placeholder telegraphs "RGB
// histogram coming here" without claiming to be real data.
//
// Note: maple-common already ships a `<maple-histogram>` in
// `components/scopes/` — that one renders LIVE pixel-data histograms
// from a `DecodedImage` and lives in the Develop tab Scopes panel.
// This `<app-info-histogram>` is the lighter inspector/sheet version
// that will switch to a server-rendered image fetch when the endpoint
// is ready. Separate selector + path so the two don't collide.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { Asset } from '../models/asset';

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
  readonly asset = input<Asset | null>(null);
}
