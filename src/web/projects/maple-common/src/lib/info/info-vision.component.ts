// InfoVisionComponent — Self-Hosted enrichment "Vision" section.
//
// Read-only structured visual classification emitted by the qwen2.5-vl
// describe stage (subjects, scene/setting/activity/shot-type chips,
// mood/composition/time/lighting/weather secondary row, notable
// objects, colors, OCR text). No edit / requeue UI: the describe-stage
// requeue already lives on the Description section directly above.

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import type { ApiAssetDetail } from '../api/bun-api-backend.service';

@Component({
  selector: 'app-info-vision',
  standalone: true,
  imports: [MapleCollapsibleComponent],
  templateUrl: './info-vision.component.html',
  styleUrl: './info-vision.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-vision',
  },
})
export class InfoVisionComponent {
  readonly detail = input.required<ApiAssetDetail>();
}
