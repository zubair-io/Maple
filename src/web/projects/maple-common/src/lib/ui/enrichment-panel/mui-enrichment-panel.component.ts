// MuiEnrichmentPanel — Maple UI Organisms (unified-component-catalog.md
// §4.3). AI-derived fields with live status, built from Description Field,
// Faces Row, Place Row, Transcript Block, Vision Row, Badge. No top-level
// loading/empty state of its own — each field molecule already degrades to
// its own placeholder/empty appearance given empty inputs (e.g. an empty
// description falls back to Description Field's own placeholder text), so
// this panel just wires status through to a small badge next to the
// description.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiDescriptionFieldComponent } from '../description-field/mui-description-field.component';
import { MuiFacesRowComponent } from '../faces-row/mui-faces-row.component';
import { MuiPlaceRowComponent } from '../place-row/mui-place-row.component';
import { MuiTranscriptBlockComponent } from '../transcript-block/mui-transcript-block.component';
import type { MuiTranscriptEntry } from '../transcript-block/mui-transcript-block.component';
import { MuiVisionRowComponent } from '../vision-row/mui-vision-row.component';

export type MuiEnrichmentDescriptionStatus = 'idle' | 'generating' | 'done' | 'error';

const STATUS_LABEL: Record<Exclude<MuiEnrichmentDescriptionStatus, 'idle'>, string> = {
  generating: 'Generating…',
  done: 'Done',
  error: 'Error',
};

@Component({
  selector: 'mui-enrichment-panel',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiDescriptionFieldComponent,
    MuiFacesRowComponent,
    MuiPlaceRowComponent,
    MuiTranscriptBlockComponent,
    MuiVisionRowComponent,
  ],
  templateUrl: './mui-enrichment-panel.component.html',
  styleUrl: './mui-enrichment-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiEnrichmentPanelComponent {
  readonly description = model<string>('');
  readonly descriptionStatus = input<MuiEnrichmentDescriptionStatus>('idle');
  readonly people = input.required<readonly MuiChip[]>();
  readonly peopleRedetecting = input<boolean>(false);
  readonly place = model<string>('');
  readonly placeOverridden = input<boolean>(false);
  readonly transcriptBase = input<Date | number | null>(null);
  readonly transcriptEntries = input<readonly MuiTranscriptEntry[]>([]);
  readonly visionLabels = input.required<readonly MuiChip[]>();

  readonly selectedPersonId = model<string | null>(null);

  readonly descriptionRegenerate = output<void>();
  readonly descriptionCommitted = output<string>();
  readonly peopleRedetect = output<void>();
  readonly placeCommitted = output<string>();
  readonly placeCleared = output<void>();

  readonly descriptionStatusLabel = computed(() => {
    const status = this.descriptionStatus();
    return status === 'idle' ? '' : STATUS_LABEL[status];
  });
}
