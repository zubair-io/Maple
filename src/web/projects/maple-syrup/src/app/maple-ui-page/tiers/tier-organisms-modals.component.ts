import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiAddServerModalComponent,
  MuiBackupMonitorComponent,
  MuiBatchMetadataModalComponent,
  MuiBatchRenameModalComponent,
  MuiButtonComponent,
  MuiCardDetailModalComponent,
  MuiChatComponent,
  MuiControlSurfaceComponent,
  MuiCropOverlayComponent,
  MuiCropToolbarComponent,
  MuiDeviceListComponent,
  MuiDiagnosticsComponent,
  MuiExportModalComponent,
  MuiFormFieldComponent,
  MuiImageCanvasComponent,
  MuiLibraryPickerModalComponent,
  MuiMapSurfaceComponent,
  MuiMobileControlBarComponent,
  MuiMoveToModalComponent,
  MuiNotificationFeedComponent,
  MuiPairDeviceModalComponent,
  MuiPanoramaMergeModalComponent,
  MuiPipelineMonitorComponent,
  MuiPreviewSurfaceComponent,
  MuiResultReportModalComponent,
  MuiRichTextEditorComponent,
  MuiSelectivePasteModalComponent,
  MuiSettingsSectionComponent,
  MuiSetupWizardComponent,
  MuiShareModalComponent,
  MuiStructuredDataEditorComponent,
  MuiTemplateGalleryModalComponent,
  MuiUserManagementComponent,
  MuiWhiteboardCanvasComponent,
  MuiWizardStepDirective,
} from '@maple-common';
import type {
  MuiAddServerRequest,
  MuiBackupConfig,
  MuiBackupResult,
  MuiBatchMetadataValues,
  MuiBatchRenameResult,
  MuiBatchRenameSourceItem,
  MuiCardDetailData,
  MuiChatMessageData,
  MuiControlSurfaceSlider,
  MuiCropRect,
  MuiDiagnosticCheck,
  MuiExportResultBanner,
  MuiExportSettings,
  MuiGalleryTemplate,
  MuiLibraryPickerEntry,
  MuiManagedUser,
  MuiMapAnnotationInput,
  MuiMentionableUser,
  MuiMobileControlBarTool,
  MuiMoveToTreeNode,
  MuiNotificationItem,
  MuiPairedDevice,
  MuiPanoramaFrame,
  MuiPanoramaMergeSettings,
  MuiPipelineStage,
  MuiPreviewSurfaceItem,
  MuiResultItem,
  MuiSegmentedToggleOption,
  MuiSelectivePasteGroup,
  MuiSettingsSectionBanner,
  MuiSettingsSectionFieldChange,
  MuiSettingsSectionRow,
  MuiShareMember,
  MuiTab,
  MuiWhiteboardStroke,
} from '@maple-common';

// Organism specimens (modals, editing surfaces, map, communication,
// configuration) — Wave W6 Lane B. Every card renders the real `mui-*`
// organism, composed from Wave 1–5 atoms/molecules/templates, instead of
// the static Canvas.dc.html mockup markup this tier shipped with — same
// "no drift from the shipped implementation" rationale as
// tier-molecules1-form/tier-molecules2. Specimens are backed by local
// component state so opens/closes, drags, and confirmations are all real.
@Component({
  selector: 'app-tier-organisms-modals',
  imports: [
    MuiAddServerModalComponent,
    MuiBackupMonitorComponent,
    MuiBatchMetadataModalComponent,
    MuiBatchRenameModalComponent,
    MuiButtonComponent,
    MuiCardDetailModalComponent,
    MuiChatComponent,
    MuiControlSurfaceComponent,
    MuiCropOverlayComponent,
    MuiCropToolbarComponent,
    MuiDeviceListComponent,
    MuiDiagnosticsComponent,
    MuiExportModalComponent,
    MuiFormFieldComponent,
    MuiImageCanvasComponent,
    MuiLibraryPickerModalComponent,
    MuiMapSurfaceComponent,
    MuiMobileControlBarComponent,
    MuiMoveToModalComponent,
    MuiNotificationFeedComponent,
    MuiPairDeviceModalComponent,
    MuiPanoramaMergeModalComponent,
    MuiPipelineMonitorComponent,
    MuiPreviewSurfaceComponent,
    MuiResultReportModalComponent,
    MuiRichTextEditorComponent,
    MuiSelectivePasteModalComponent,
    MuiSettingsSectionComponent,
    MuiSetupWizardComponent,
    MuiShareModalComponent,
    MuiStructuredDataEditorComponent,
    MuiTemplateGalleryModalComponent,
    MuiUserManagementComponent,
    MuiWhiteboardCanvasComponent,
    MuiWizardStepDirective,
  ],
  templateUrl: './tier-organisms-modals.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierOrganismsModalsComponent {
  // Small inline SVG data URIs — no network dependency, same convention as
  // TierAtomsComponent.specimenPhoto / TierMolecules2Component.specimenPhoto.
  // Fictional sample content throughout this tier: this page is public, so
  // no real names, emails, or asset paths ever appear here.
  readonly specimenPhoto =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'>" +
    "<rect width='160' height='120' fill='%23c4493a'/>" +
    "<circle cx='80' cy='46' r='20' fill='%23422016'/>" +
    "<rect x='36' y='78' width='88' height='30' rx='12' fill='%23422016'/></svg>";

  readonly specimenLandscape =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='120'>" +
    "<rect width='200' height='120' fill='%232f4538'/>" +
    "<circle cx='160' cy='30' r='16' fill='%23e8c468'/>" +
    "<path d='M0 90 L50 50 L90 80 L130 40 L200 90 L200 120 L0 120 Z' fill='%231c1917'/></svg>";

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

  // === 4.5 Editing surfaces ===

  // --- Image Canvas ---
  imageCanvasCropMode = false;
  imageCanvasShowBefore = false;
  imageCanvasCropRect: MuiCropRect = { x: 30, y: 20, width: 140, height: 100 };
  imageCanvasLastEvent = '—';

  toggleImageCanvasCrop(): void {
    this.imageCanvasCropMode = !this.imageCanvasCropMode;
  }

  onImageTransformChanged(): void {
    this.imageCanvasLastEvent = 'panned/zoomed';
  }

  // --- Crop Overlay ---
  readonly cropOverlayContainerSize = { width: 220, height: 150 };
  cropOverlayRect: MuiCropRect = { x: 30, y: 20, width: 140, height: 100 };
  cropOverlayLastEvent = '—';

  onCropOverlayCommitted(rect: MuiCropRect): void {
    this.cropOverlayLastEvent = `rect → ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  }

  // --- Crop Toolbar ---
  cropToolbarAspect = '4:5';
  cropToolbarAngle = 2.5;
  cropToolbarLastEvent = '—';

  onCropToolbarReset(): void {
    this.cropToolbarLastEvent = 'reset';
  }

  // --- Control Surface ---
  readonly controlSurfaceTabs: readonly MuiTab[] = [
    { id: 'exposure', label: 'Exposure' },
    { id: 'color', label: 'Color' },
    { id: 'crop', label: 'Crop' },
  ];
  controlSurfaceActiveTab = 'exposure';
  controlSurfaceSliders: readonly MuiControlSurfaceSlider[] = [
    { id: 'exposure', label: 'Exposure', value: 0.3, min: -5, max: 5, step: 0.1, unit: 'EV' },
    { id: 'contrast', label: 'Contrast', value: 12, min: -100, max: 100, step: 1, unit: '' },
  ];
  controlSurfaceLastEvent = '—';

  onControlTabChanged(id: string): void {
    this.controlSurfaceActiveTab = id;
  }
  onControlSliderChanged(change: { id: string; value: number }): void {
    this.controlSurfaceSliders = this.controlSurfaceSliders.map((slider) =>
      slider.id === change.id ? { ...slider, value: change.value } : slider,
    );
    this.controlSurfaceLastEvent = `${change.id} → ${change.value}`;
  }

  // --- Mobile Control Bar ---
  readonly mobileControlTools: readonly MuiMobileControlBarTool[] = [
    { id: 'exposure', icon: 'tool-exposure', label: 'Light' },
    { id: 'color', icon: 'tool-hsl', label: 'Color' },
    { id: 'crop', icon: 'tool-crop', label: 'Crop' },
  ];
  mobileControlToolId = 'exposure';
  readonly mobileControlTabs: readonly MuiTab[] = [{ id: 'exposure', label: 'Exposure' }];
  mobileControlActiveTab = 'exposure';
  mobileControlSliders: readonly MuiControlSurfaceSlider[] = [
    { id: 'exposure', label: 'Exposure', value: 0.3, min: -5, max: 5, step: 0.1, unit: 'EV' },
  ];
  mobileControlLastEvent = '—';

  onMobileToolSelected(id: string): void {
    this.mobileControlToolId = id;
    this.mobileControlLastEvent = `tool → ${id}`;
  }
  onMobileSliderChanged(change: { id: string; value: number }): void {
    this.mobileControlSliders = this.mobileControlSliders.map((slider) =>
      slider.id === change.id ? { ...slider, value: change.value } : slider,
    );
    this.mobileControlLastEvent = `${change.id} → ${change.value}`;
  }

  // --- Rich Text Editor ---
  richTextValue = '<p>Today we discussed the roadmap for the fall release.</p>';
  richTextLastEvent = '—';

  onCommandExecuted(id: string): void {
    this.richTextLastEvent = `command → ${id}`;
  }

  // --- Whiteboard Canvas ---
  whiteboardTool: 'pen' | 'eraser' = 'pen';
  whiteboardStrokes: readonly MuiWhiteboardStroke[] = [];
  whiteboardPrompt = '';
  whiteboardLastEvent = '—';

  onPromptSubmitted(text: string): void {
    this.whiteboardLastEvent = `prompt → "${text}"`;
  }

  // --- Structured Data Editor ---
  structuredDataValue: Record<string, string | number | boolean> = {
    lens: '85mm f/1.4',
    iso: 400,
    flash: false,
  };
  structuredDataError: string | null = null;

  onStructuredParseError(message: string | null): void {
    this.structuredDataError = message;
  }

  // --- Preview Surface ---
  readonly previewSurfaceItems: readonly MuiPreviewSurfaceItem[] = [
    { id: 'v1', kind: 'image', src: this.specimenLandscape, alt: 'Frame 1' },
    { id: 'v2', kind: 'image', src: this.specimenPhoto, alt: 'Frame 2' },
    { id: 'v3', kind: 'image', src: this.specimenLandscape, alt: 'Frame 3' },
  ];
  previewSurfaceActiveId: string | null = 'v1';
  previewSurfaceLastEvent = '—';

  onPreviewActiveChanged(id: string): void {
    this.previewSurfaceActiveId = id;
  }
  onPreviewToolbarAction(id: string): void {
    this.previewSurfaceLastEvent = `toolbar → ${id}`;
  }

  // === 4.6 Map ===

  readonly mapAnnotations: readonly MuiMapAnnotationInput[] = [
    { id: 'm1', x: 0.28, y: 0.35, label: 'Ballet Session' },
    { id: 'm2', x: 0.3, y: 0.37, label: 'Studio B' },
    { id: 'm3', x: 0.72, y: 0.6, label: 'Coastal Shoot' },
  ];
  mapHeatmapVisible = false;
  mapLastEvent = '—';

  onMapAnnotationSelected(id: string): void {
    this.mapLastEvent = `selected → ${id}`;
  }
  onMapHeatmapToggled(visible: boolean): void {
    this.mapHeatmapVisible = visible;
  }

  // === 4.7 Communication ===

  // --- Chat ---
  chatMessages: readonly MuiChatMessageData[] = [
    { id: 'c1', author: 'Sam', text: 'Sounds good!', sentAt: Date.now() - 5 * 60_000, own: false },
    { id: 'c2', author: 'You', text: 'On it 👍', sentAt: Date.now() - 4 * 60_000, own: true },
  ];
  chatOthersTyping = true;
  readonly chatMentionableUsers: readonly MuiMentionableUser[] = [
    { id: 'u1', name: 'Sam Ortiz' },
    { id: 'u2', name: 'Priya Shah' },
  ];

  onMessageSent(text: string): void {
    this.chatMessages = [
      ...this.chatMessages,
      {
        id: `c${this.chatMessages.length + 1}`,
        author: 'You',
        text,
        sentAt: Date.now(),
        own: true,
      },
    ];
  }

  // --- Notification Feed ---
  readonly notificationItems: readonly MuiNotificationItem[] = [
    {
      id: 'n1',
      label: 'Jane commented on your page',
      category: 'mentions',
      timestamp: Date.now() - 3_600_000,
      read: false,
    },
    {
      id: 'n2',
      label: 'Sam shared a notebook',
      category: 'shares',
      timestamp: Date.now() - 7_200_000,
      read: false,
    },
    {
      id: 'n3',
      label: 'Priya mentioned you in Ballet Session',
      category: 'mentions',
      timestamp: Date.now() - 86_400_000,
      read: true,
    },
  ];
  notificationLastEvent = '—';

  onNotificationOpened(id: string): void {
    this.notificationLastEvent = `opened → ${id}`;
  }
  onNotificationMarkedRead(id: string): void {
    this.notificationLastEvent = `read → ${id}`;
  }

  // === 4.8 Configuration ===

  // --- Settings Section ---
  readonly settingsRows: readonly MuiSettingsSectionRow[] = [
    {
      kind: 'navigate',
      id: 'storage',
      label: 'Storage location',
      value: '/Volumes/Photos',
      icon: 'folder',
    },
    {
      kind: 'navigate',
      id: 'workers',
      label: 'Worker pipeline',
      value: '4 stages active',
      icon: 'gear',
    },
    {
      kind: 'edit',
      id: 'sync-interval',
      label: 'Sync interval',
      value: '15 minutes',
      help: 'How often remote sources are re-scanned.',
      icon: 'history',
    },
  ];
  readonly settingsBanner: MuiSettingsSectionBanner = {
    message: 'Changes require restart',
    variant: 'warning',
  };
  settingsLastEvent = '—';

  onSettingsRowActivated(id: string): void {
    this.settingsLastEvent = `navigate → ${id}`;
  }
  onSettingsFieldChanged(change: MuiSettingsSectionFieldChange): void {
    this.settingsLastEvent = `${change.id} = ${change.value}`;
  }

  // --- Pipeline Monitor ---
  readonly pipelineStages: readonly MuiPipelineStage[] = [
    { id: 'exif', name: 'exif', status: 'done', processed: 12480, total: 12480 },
    { id: 'thumb', name: 'thumb', status: 'running', processed: 9963, total: 12480 },
    { id: 'describe', name: 'describe', status: 'error', processed: 4211, total: 12480 },
    { id: 'geocode', name: 'geocode', status: 'paused', processed: 0, total: 12480 },
  ];
  pipelineLastEvent = '—';

  onStagePauseToggled(id: string): void {
    this.pipelineLastEvent = `toggle → ${id}`;
  }
  onStageRetried(id: string): void {
    this.pipelineLastEvent = `retry → ${id}`;
  }

  // --- Setup Wizard ---
  readonly wizardSteps: readonly string[] = ['Library location', 'Worker pipeline', 'Backup'];
  wizardIndex = 0;
  wizardLibraryPath = '';
  wizardLastEvent = '—';

  get wizardCanGoNext(): boolean {
    return this.wizardIndex !== 0 || this.wizardLibraryPath.trim().length > 0;
  }

  onWizardStepChanged(index: number): void {
    this.wizardIndex = index;
    this.wizardLastEvent = `step → ${index}`;
  }
  onWizardFinished(): void {
    this.wizardLastEvent = 'finished';
  }

  // --- User Management ---
  readonly managedUsers: readonly MuiManagedUser[] = [
    { id: 'u1', name: 'Ada Voss', email: 'ada@example.com', role: 'Owner' },
    { id: 'u2', name: 'Priya Nair', email: 'priya@example.com', role: 'Editor' },
    { id: 'u3', name: 'Tom Okafor', email: 'tom@example.com', role: 'Viewer' },
  ];
  userMgmtLastEvent = '—';

  onUserInvited(email: string): void {
    this.userMgmtLastEvent = `invited → ${email}`;
  }
  onUserRevoked(id: string): void {
    this.userMgmtLastEvent = `revoked → ${id}`;
  }

  // --- Device List ---
  readonly pairedDevices: readonly MuiPairedDevice[] = [
    { id: 'd1', name: 'MacBook Pro', platform: 'macOS 15', lastSeen: Date.now() - 120_000 },
    { id: 'd2', name: 'iPhone 15', platform: 'iOS 19', lastSeen: Date.now() - 3_600_000 },
    { id: 'd3', name: 'iPad Pro', platform: 'iPadOS 19', lastSeen: Date.now() - 86_400_000 },
  ];
  deviceLastEvent = '—';

  onDeviceRevoked(id: string): void {
    this.deviceLastEvent = `revoked → ${id}`;
  }

  // --- Backup Monitor ---
  backupRunning = true;
  backupProgress = 62;
  backupLastResult: MuiBackupResult | null = {
    message: 'Last backup completed 2026-08-22 02:00 — 12,480 files, 1.9 TB.',
    variant: 'success',
  };
  backupLastEvent = '—';

  onBackupConfigChanged(config: MuiBackupConfig): void {
    this.backupLastEvent = `${config.destinationPath} @ ${config.schedule}`;
  }
  onBackupStartRequested(): void {
    this.backupLastEvent = 'run requested';
  }

  // --- Diagnostics ---
  readonly diagnosticChecks: readonly MuiDiagnosticCheck[] = [
    { id: 'xmp-roundtrip', label: 'XMP sidecar round-trip', status: 'pass' },
    { id: 'raw-core-ffi', label: 'raw-core FFI link', status: 'fail' },
    { id: 'meili-index', label: 'Meilisearch index reachable', status: 'pass' },
    { id: 'mongo-conn', label: 'MongoDB connection', status: 'pending' },
  ];
  readonly diagnosticOutput =
    'xmp-roundtrip: OK (14 ms)\nraw-core-ffi: FAILED — symbol maple_pano_stitch not found\nmeili-index: OK (203 ms)\nmongo-conn: …';
  diagnosticsRunning = false;
  diagLastEvent = '—';

  onDiagnosticsRun(): void {
    this.diagLastEvent = 'run requested';
  }
}
