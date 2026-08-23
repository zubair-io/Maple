import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiBotOutputComponent,
  MuiButtonComponent,
  MuiCardComponent,
  MuiChatMessageComponent,
  MuiDescriptionFieldComponent,
  MuiDialogComponent,
  MuiEmbedShellComponent,
  MuiEndpointFormComponent,
  MuiEventPopoverComponent,
  MuiFacesRowComponent,
  MuiFilmstripRailComponent,
  MuiFilmstripRowComponent,
  MuiKeywordRowComponent,
  MuiMediaCellComponent,
  MuiPlaceRowComponent,
  MuiPreviewListComponent,
  MuiProgressStepComponent,
  MuiQrScannerComponent,
  MuiResponseViewerComponent,
  MuiSettingsRowComponent,
  MuiSuggestionPreviewComponent,
  MuiTextComponent,
  MuiTodoPopoverComponent,
  MuiTranscriptBlockComponent,
  MuiTypingIndicatorComponent,
  MuiVisionRowComponent,
} from '@maple-common';
import type { MuiChip, MuiFilmstripItem, MuiPreviewItem, MuiTranscriptEntry } from '@maple-common';

// Molecules L2 specimens (unified-component-catalog.md §3) — Wave 4
// (#3000). Every card renders the real `mui-*` molecule, composed from the
// wave 1-3 atoms and Level-1 molecules, instead of the static Canvas.dc.html
// mockup markup this tier shipped with — same "no drift from the shipped
// implementation" rationale as tier-molecules1-form. Specimens are backed by
// local component state so drags, clicks, and streaming are all real.
@Component({
  selector: 'app-tier-molecules2',
  imports: [
    MuiBotOutputComponent,
    MuiButtonComponent,
    MuiCardComponent,
    MuiChatMessageComponent,
    MuiDescriptionFieldComponent,
    MuiDialogComponent,
    MuiEmbedShellComponent,
    MuiEndpointFormComponent,
    MuiEventPopoverComponent,
    MuiFacesRowComponent,
    MuiFilmstripRailComponent,
    MuiFilmstripRowComponent,
    MuiKeywordRowComponent,
    MuiMediaCellComponent,
    MuiPlaceRowComponent,
    MuiPreviewListComponent,
    MuiProgressStepComponent,
    MuiQrScannerComponent,
    MuiResponseViewerComponent,
    MuiSettingsRowComponent,
    MuiSuggestionPreviewComponent,
    MuiTextComponent,
    MuiTodoPopoverComponent,
    MuiTranscriptBlockComponent,
    MuiTypingIndicatorComponent,
    MuiVisionRowComponent,
  ],
  templateUrl: './tier-molecules2.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierMolecules2Component {
  // Small inline SVG data URI — no network dependency, same convention as
  // TierAtomsComponent.specimenPhoto.
  readonly specimenPhoto =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>" +
    "<rect width='80' height='80' fill='%23c4493a'/>" +
    "<circle cx='40' cy='32' r='14' fill='%23422016'/>" +
    "<rect x='16' y='52' width='48' height='20' rx='8' fill='%23422016'/></svg>";

  // --- Media Cell ---
  mediaCellFilename = 'DSC_0003.NEF';

  // --- Dialog ---
  dialogOpen = false;

  // --- Description Field ---
  descriptionValue = 'A dancer stretching outdoors.';

  // --- Transcript Block ---
  readonly transcriptBase = new Date('2026-01-01T10:00:00Z').getTime();
  readonly transcriptEntries: readonly MuiTranscriptEntry[] = [
    { id: '1', offsetMs: 4000, speaker: 'Nick', text: 'So we beat on...' },
  ];

  // --- Faces Row ---
  readonly facesPeople: readonly MuiChip[] = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];

  // --- Vision Row ---
  readonly visionLabels: readonly MuiChip[] = [
    { id: 'outdoor', label: 'outdoor' },
    { id: 'portrait', label: 'portrait' },
    { id: 'dance', label: 'dance' },
  ];

  // --- Keyword Row ---
  readonly keywordChips: readonly MuiChip[] = [
    { id: 'family', label: 'family' },
    { id: '2026', label: '2026' },
  ];

  // --- Preview List ---
  readonly previewItems: readonly MuiPreviewItem[] = [
    { id: '1', before: 'IMG_003.NEF', after: 'ballet-003.nef' },
  ];

  // --- Response Viewer ---
  readonly responseBody = '{ "ok": true }';
  readonly responseHeaders = 'content-type: application/json';

  // --- Filmstrip Row / Rail ---
  readonly filmstripItems: readonly MuiFilmstripItem[] = [
    { id: 'f1', src: this.specimenPhoto, alt: 'Frame 1' },
    { id: 'f2', src: this.specimenPhoto, alt: 'Frame 2' },
    { id: 'f3', src: this.specimenPhoto, alt: 'Frame 3' },
    { id: 'f4', src: this.specimenPhoto, alt: 'Frame 4' },
  ];
  filmstripRowActiveId: string | null = 'f2';
  filmstripRailActiveId: string | null = 'f1';

  // --- Chat Message ---
  // Fixed reference instant — a live `Date.now()` in the template would make
  // this specimen silently drift as the page stays open (same rationale as
  // TierMolecules1FormComponent's meeting-notes timestamp fixture).
  readonly chatSentAt = Date.now() - 2 * 60_000;

  // --- Todo Popover / Event Popover ---
  readonly priorities: readonly MuiChip[] = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
  ];
}
