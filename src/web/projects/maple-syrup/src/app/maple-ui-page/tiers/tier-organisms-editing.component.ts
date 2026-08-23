import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiBackupMonitorComponent,
  MuiButtonComponent,
  MuiChatComponent,
  MuiControlSurfaceComponent,
  MuiCropOverlayComponent,
  MuiCropToolbarComponent,
  MuiDeviceListComponent,
  MuiDiagnosticsComponent,
  MuiFormFieldComponent,
  MuiImageCanvasComponent,
  MuiMapSurfaceComponent,
  MuiMobileControlBarComponent,
  MuiNotificationFeedComponent,
  MuiPipelineMonitorComponent,
  MuiPreviewSurfaceComponent,
  MuiRichTextEditorComponent,
  MuiSettingsSectionComponent,
  MuiSetupWizardComponent,
  MuiStructuredDataEditorComponent,
  MuiUserManagementComponent,
  MuiWhiteboardCanvasComponent,
  MuiWizardStepDirective,
} from '@maple-common';
import type {
  MuiBackupConfig,
  MuiBackupResult,
  MuiChatMessageData,
  MuiControlSurfaceSlider,
  MuiCropRect,
  MuiDiagnosticCheck,
  MuiManagedUser,
  MuiMapAnnotationInput,
  MuiMentionableUser,
  MuiMobileControlBarTool,
  MuiNotificationItem,
  MuiPairedDevice,
  MuiPipelineStage,
  MuiPreviewSurfaceItem,
  MuiSettingsSectionBanner,
  MuiSettingsSectionFieldChange,
  MuiSettingsSectionRow,
  MuiTab,
  MuiWhiteboardStroke,
} from '@maple-common';
import { specimenLandscape, specimenPhoto } from './specimen-data';

// Organism specimens (editing surfaces, map, communication, configuration)
// — Wave W6 Lane B, catalog sections 4.5-4.8. Every card renders the real
// `mui-*` organism, composed from Wave 1–5 atoms/molecules/templates,
// instead of the static Canvas.dc.html mockup markup this tier shipped
// with — same "no drift from the shipped implementation" rationale as
// tier-molecules1-form/tier-molecules2. Specimens are backed by local
// component state so opens/closes, drags, and confirmations are all real.
// Section 4.4 (modals) lives in TierOrganismsModalsComponent — split out
// to stay under the file-budget ceiling.
@Component({
  selector: 'app-tier-organisms-editing',
  imports: [
    MuiBackupMonitorComponent,
    MuiButtonComponent,
    MuiChatComponent,
    MuiControlSurfaceComponent,
    MuiCropOverlayComponent,
    MuiCropToolbarComponent,
    MuiDeviceListComponent,
    MuiDiagnosticsComponent,
    MuiFormFieldComponent,
    MuiImageCanvasComponent,
    MuiMapSurfaceComponent,
    MuiMobileControlBarComponent,
    MuiNotificationFeedComponent,
    MuiPipelineMonitorComponent,
    MuiPreviewSurfaceComponent,
    MuiRichTextEditorComponent,
    MuiSettingsSectionComponent,
    MuiSetupWizardComponent,
    MuiStructuredDataEditorComponent,
    MuiUserManagementComponent,
    MuiWhiteboardCanvasComponent,
    MuiWizardStepDirective,
  ],
  templateUrl: './tier-organisms-editing.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierOrganismsEditingComponent {
  readonly specimenPhoto = specimenPhoto;
  readonly specimenLandscape = specimenLandscape;

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
