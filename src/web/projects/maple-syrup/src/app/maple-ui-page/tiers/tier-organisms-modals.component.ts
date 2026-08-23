import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiAddServerModalComponent,
  MuiBatchMetadataModalComponent,
  MuiBatchRenameModalComponent,
  MuiButtonComponent,
  MuiCardDetailModalComponent,
  MuiExportModalComponent,
  MuiLibraryPickerModalComponent,
  MuiMoveToModalComponent,
  MuiPairDeviceModalComponent,
  MuiPanoramaMergeModalComponent,
  MuiResultReportModalComponent,
  MuiSelectivePasteModalComponent,
  MuiShareModalComponent,
  MuiTemplateGalleryModalComponent,
} from '@maple-common';
import type {
  MuiAddServerRequest,
  MuiBatchMetadataValues,
  MuiBatchRenameResult,
  MuiBatchRenameSourceItem,
  MuiCardDetailData,
  MuiExportResultBanner,
  MuiExportSettings,
  MuiGalleryTemplate,
  MuiLibraryPickerEntry,
  MuiMoveToTreeNode,
  MuiPanoramaFrame,
  MuiPanoramaMergeSettings,
  MuiResultItem,
  MuiSegmentedToggleOption,
  MuiSelectivePasteGroup,
  MuiShareMember,
} from '@maple-common';
import { specimenLandscape, specimenPhoto } from './specimen-data';

// Organism specimens (modals) — Wave W6 Lane B, catalog section 4.4. Every
// card renders the real `mui-*` organism, composed from Wave 1–5
// atoms/molecules/templates, instead of the static Canvas.dc.html mockup
// markup this tier shipped with — same "no drift from the shipped
// implementation" rationale as tier-molecules1-form/tier-molecules2.
// Specimens are backed by local component state so opens/closes, drags,
// and confirmations are all real. Sections 4.5-4.8 (editing surfaces, map,
// communication, configuration) live in TierOrganismsEditingComponent —
// split out to stay under the file-budget ceiling.
@Component({
  selector: 'app-tier-organisms-modals',
  imports: [
    MuiAddServerModalComponent,
    MuiBatchMetadataModalComponent,
    MuiBatchRenameModalComponent,
    MuiButtonComponent,
    MuiCardDetailModalComponent,
    MuiExportModalComponent,
    MuiLibraryPickerModalComponent,
    MuiMoveToModalComponent,
    MuiPairDeviceModalComponent,
    MuiPanoramaMergeModalComponent,
    MuiResultReportModalComponent,
    MuiSelectivePasteModalComponent,
    MuiShareModalComponent,
    MuiTemplateGalleryModalComponent,
  ],
  templateUrl: './tier-organisms-modals.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierOrganismsModalsComponent {
  readonly specimenPhoto = specimenPhoto;
  readonly specimenLandscape = specimenLandscape;

  // === 4.4 Modals ===

  // --- Export ---
  exportOpen = false;
  readonly exportFormatOptions: readonly MuiSegmentedToggleOption[] = [
    { value: 'jpeg', label: 'JPEG' },
    { value: 'tiff', label: 'TIFF' },
    { value: 'dng', label: 'DNG' },
  ];
  readonly exportColorSpaceOptions: readonly MuiSegmentedToggleOption[] = [
    { value: 'srgb', label: 'sRGB' },
    { value: 'p3', label: 'Display P3' },
    { value: 'rec2020', label: 'Rec.2020' },
  ];
  exportFormat = 'jpeg';
  exportQuality = 90;
  exportColorSpace = 'srgb';
  exportExporting = false;
  exportProgress = 70;
  exportResultBanner: MuiExportResultBanner | null = null;
  exportLastEvent = '—';

  onExportRequested(settings: MuiExportSettings): void {
    this.exportExporting = true;
    this.exportResultBanner = null;
    this.exportLastEvent = `export → ${settings.format} / ${settings.colorSpace} @ q${settings.quality}`;
  }

  // --- Batch Rename ---
  batchRenameOpen = false;
  readonly batchRenameItems: readonly MuiBatchRenameSourceItem[] = [
    { id: 'r1', filename: 'IMG_0031.NEF', date: '2026-03-04', camera: 'Z8' },
    { id: 'r2', filename: 'IMG_0032.NEF', date: '2026-03-04', camera: 'Z8' },
    { id: 'r3', filename: 'IMG_0033.NEF', date: '2026-03-04', camera: 'Z8' },
  ];
  batchRenameLastEvent = '—';

  onRenameConfirmed(result: MuiBatchRenameResult): void {
    this.batchRenameLastEvent = `renamed ${result.mapping.length} → "${result.template}"`;
  }

  // --- Batch Metadata ---
  batchMetadataOpen = false;
  batchMetadataLastEvent = '—';

  onApplyRequested(values: MuiBatchMetadataValues): void {
    this.batchMetadataLastEvent = `applied — ${values.keywords.length} keyword(s), rating ${values.rating}`;
  }

  // --- Move To ---
  moveToOpen = false;
  readonly moveToNodes: readonly MuiMoveToTreeNode[] = [
    { id: 'lib', parentId: null, name: 'Library', depth: 0, hasChildren: true },
    { id: '2026', parentId: 'lib', name: '2026 Client Work', depth: 1, hasChildren: true },
    { id: 'ballet', parentId: '2026', name: 'Ballet Session', depth: 2, hasChildren: false },
    { id: 'wedding', parentId: '2026', name: 'Wedding — Nair', depth: 2, hasChildren: false },
    { id: 'archive', parentId: 'lib', name: 'Archive', depth: 1, hasChildren: false },
  ];
  moveToSelectedId: string | null = 'ballet';
  moveToLastEvent = '—';

  onMoveConfirmed(destination: string): void {
    this.moveToLastEvent = `moved → ${destination}`;
  }

  // --- Panorama Merge ---
  panoramaMergeOpen = false;
  readonly panoramaFrames: readonly MuiPanoramaFrame[] = [
    { id: 'p1', src: this.specimenLandscape, alt: 'Frame 1' },
    { id: 'p2', src: this.specimenLandscape, alt: 'Frame 2' },
    { id: 'p3', src: this.specimenLandscape, alt: 'Frame 3' },
  ];
  panoramaMergeStitching = true;
  panoramaMergeProgress = 45;
  panoramaMergeLastEvent = '—';

  onMergeRequested(settings: MuiPanoramaMergeSettings): void {
    this.panoramaMergeLastEvent = `merge → ${settings.projection} / ${settings.blendMode}`;
  }

  // --- Selective Paste ---
  selectivePasteOpen = false;
  selectivePasteGroups: readonly MuiSelectivePasteGroup[] = [
    {
      id: 'exposure',
      label: 'Exposure',
      description: 'Exposure, contrast, tone curve',
      enabled: true,
    },
    {
      id: 'color',
      label: 'Color',
      description: 'White balance, HSL, color grading',
      enabled: true,
    },
    { id: 'crop', label: 'Crop', description: 'Crop rect and straighten angle', enabled: false },
  ];
  selectivePasteLastEvent = '—';

  onPasteConfirmed(ids: readonly string[]): void {
    this.selectivePasteLastEvent = `pasted → ${ids.join(', ') || 'none'}`;
  }

  // --- Library Picker ---
  libraryPickerOpen = false;
  readonly libraryPickerPath: readonly string[] = ['home-server', 'Photos'];
  readonly libraryPickerEntries: readonly MuiLibraryPickerEntry[] = [
    { id: 'f1', name: '2026 Client Work', kind: 'folder', itemCount: 412 },
    { id: 'f2', name: 'Archive', kind: 'folder', itemCount: 8210 },
    { id: 'file1', name: 'contact-sheet.pdf', kind: 'file' },
  ];
  libraryPickerLoading = false;
  libraryPickerError: string | null = null;
  libraryPickerLastEvent = '—';

  onLibraryEntrySelected(id: string): void {
    this.libraryPickerLastEvent = `selected → ${id}`;
  }
  onLibraryFolderOpened(name: string): void {
    this.libraryPickerLastEvent = `opened → ${name}`;
  }

  // --- Add Server ---
  addServerOpen = false;
  addServerHost = 'server.local:8080';
  addServerUsername = 'ada';
  addServerPassword = '';
  addServerConnecting = false;
  addServerError: string | null = null;
  addServerLastEvent = '—';

  onConnectRequested(request: MuiAddServerRequest): void {
    this.addServerConnecting = true;
    this.addServerLastEvent = `connect → ${request.host} as ${request.username}`;
  }

  // --- Pair Device ---
  pairDeviceOpen = false;
  pairDeviceStep = 0;
  readonly pairDeviceCode = 'MPL-7F2Q-9X';
  pairDeviceLastEvent = '—';

  onPairStepChanged(step: number): void {
    this.pairDeviceStep = step;
    this.pairDeviceLastEvent = `step → ${step}`;
  }
  onPaired(code: string): void {
    this.pairDeviceLastEvent = `paired → ${code}`;
  }

  // --- Share ---
  shareOpen = false;
  shareMembers: readonly MuiShareMember[] = [
    { id: 's1', name: 'Jordan Ames', role: 'Editor', avatarUrl: null },
    { id: 's2', name: 'Sam Ortiz', role: 'Viewer', avatarUrl: null },
  ];
  shareLastEvent = '—';

  onMemberInvited(value: string): void {
    this.shareLastEvent = `invited → ${value}`;
  }
  onMemberRemoved(id: string): void {
    this.shareMembers = this.shareMembers.filter((member) => member.id !== id);
    this.shareLastEvent = `removed → ${id}`;
  }

  // --- Template Gallery ---
  templateGalleryOpen = false;
  readonly galleryTemplates: readonly MuiGalleryTemplate[] = [
    {
      id: 't1',
      name: 'Golden Hour',
      thumbnailUrl: this.specimenLandscape,
      description: 'Warm highlights, lifted shadows',
      category: 'Landscape',
    },
    {
      id: 't2',
      name: 'Studio Portrait',
      thumbnailUrl: this.specimenPhoto,
      description: 'Neutral skin tones, soft contrast',
      category: 'Portrait',
    },
  ];
  templateGalleryLastEvent = '—';

  onTemplateApplied(template: MuiGalleryTemplate): void {
    this.templateGalleryLastEvent = `applied → ${template.name}`;
  }

  // --- Card Detail ---
  cardDetailOpen = false;
  cardDetailLastEvent = '—';

  onCardSaved(data: MuiCardDetailData): void {
    this.cardDetailLastEvent = `saved → "${data.title}" (${data.priority ?? 'no priority'})`;
  }

  // --- Result Report ---
  resultReportOpen = false;
  readonly resultReportItems: readonly MuiResultItem[] = [
    { id: 'e1', label: 'IMG_0031.jpg', status: 'success' },
    { id: 'e2', label: 'IMG_0032.jpg', status: 'success' },
    { id: 'e3', label: 'IMG_0033.jpg', status: 'error', detail: 'Disk full' },
    { id: 'e4', label: 'IMG_0034.jpg', status: 'skipped', detail: 'Already exported' },
  ];
  resultReportLastEvent = '—';

  onRetryFailed(ids: readonly string[]): void {
    this.resultReportLastEvent = `retry → ${ids.join(', ')}`;
  }
}
