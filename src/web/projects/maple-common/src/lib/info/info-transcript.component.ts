// InfoTranscriptComponent — Self-Hosted enrichment "Transcript" section.
//
// Read-only speech-to-text from the transcribe stage (whisper.cpp),
// present only on video/audio assets. Renders `transcript.text` as a
// plain scrollable block with a `language · model` provenance footer —
// mirroring how the Vision section renders OCR text. No edit / requeue
// UI: the transcribe stage has no manual-override or per-asset requeue
// surface (it is not part of the geocode/describe/face enrichment set
// the orchestrator polls). Hidden entirely when there is no transcript.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import type { ApiAssetDetail } from '../api/bun-api-backend.service';

@Component({
  selector: 'app-info-transcript',
  standalone: true,
  imports: [MapleCollapsibleComponent],
  templateUrl: './info-transcript.component.html',
  styleUrl: './info-transcript.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-transcript',
  },
})
export class InfoTranscriptComponent {
  readonly detail = input.required<ApiAssetDetail>();

  /** `language · model` with blank parts dropped — a whisper run can return
   * `language: ""`, and joining unconditionally would render an orphaned
   * `· whisper-base`. Mirrors the Swift client's `footer(language:model:)`
   * so both platforms render the same footer for the same transcript. */
  readonly footer = computed(() => {
    const t = this.detail().transcript;
    if (!t) return '';
    return [t.language, t.model]
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .join(' · ');
  });
}
