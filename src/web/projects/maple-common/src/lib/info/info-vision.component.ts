// InfoVisionComponent — Self-Hosted enrichment "Vision" section.
//
// Read-only structured visual classification emitted by the describe
// stage (screenshot/people-count badges, subjects,
// scene/setting/activity/shot-type chips, mood/framing/time/lighting/
// weather secondary row, notable objects, search keywords, colors, OCR
// text). Prompt v5's screenshot short-circuit nulls
// scene_type/shot_type/framing/time_of_day/lighting/weather on
// screenshots, so every one of those chips is gated on a populated
// value in the template. `tags`, `people_count`, and `framing` are all
// absent on rows the prompt-v7 re-describe hasn't reached yet, so the
// template guards each one rather than assuming the current shape. No edit / requeue UI: the describe-stage
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
