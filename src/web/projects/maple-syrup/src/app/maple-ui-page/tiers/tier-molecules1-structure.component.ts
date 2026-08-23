import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import {
  MuiAudioPlayerComponent,
  MuiAvatarGroupComponent,
  MuiBubbleMenuComponent,
  MuiCodeBlockComponent,
  MuiCollapsibleComponent,
  MuiCommandMenuComponent,
  MuiConnectionGraphComponent,
  MuiContextMenuComponent,
  MuiCurvePlotComponent,
  MuiDragPreviewComponent,
  MuiHeatmapLayerComponent,
  MuiHistogramComponent,
  MuiLabelValueGridComponent,
  MuiMapAnnotationComponent,
  MuiPageHeaderComponent,
  MuiParadeComponent,
  MuiPopoverComponent,
  MuiPreviewImageComponent,
  MuiSuggestionMenuComponent,
  MuiToolbarComponent,
  MuiVectorscopeComponent,
  MuiVideoPlayerComponent,
  MuiWaveformComponent,
} from '@maple-common';
import type {
  MuiAvatarGroupMember,
  MuiBubbleMenuEntry,
  MuiConnectionGraphLink,
  MuiConnectionGraphNode,
  MuiContextMenuEntry,
  MuiCurvePoint,
  MuiLabelValueRow,
  MuiSuggestionItem,
  MuiToolbarEntry,
  MuiVectorscopeSample,
} from '@maple-common';

// Molecules L1 (overlays, structure, plots, media) specimens ported from
// the Unified Component Catalog canvas (Canvas.dc.html, claude.ai/design
// project 288a7180) — every element now renders the real `mui-*` component
// against a dark backdrop chip instead of static mockup markup, matching
// the wave-1/wave-2 atoms tier (`tier-atoms.component`), so this page can
// never drift from the shipped implementation.
@Component({
  selector: 'app-tier-molecules1-structure',
  imports: [
    MuiPopoverComponent,
    MuiContextMenuComponent,
    MuiSuggestionMenuComponent,
    MuiCommandMenuComponent,
    MuiCollapsibleComponent,
    MuiPageHeaderComponent,
    MuiToolbarComponent,
    MuiBubbleMenuComponent,
    MuiLabelValueGridComponent,
    MuiAvatarGroupComponent,
    MuiHistogramComponent,
    MuiWaveformComponent,
    MuiParadeComponent,
    MuiVectorscopeComponent,
    MuiCurvePlotComponent,
    MuiConnectionGraphComponent,
    MuiHeatmapLayerComponent,
    MuiMapAnnotationComponent,
    MuiPreviewImageComponent,
    MuiVideoPlayerComponent,
    MuiAudioPlayerComponent,
    MuiDragPreviewComponent,
    MuiCodeBlockComponent,
  ],
  templateUrl: './tier-molecules1-structure.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierMolecules1StructureComponent {
  // --- 2.4 Overlays & menus ---

  readonly contextMenuEntries: readonly MuiContextMenuEntry[] = [
    { id: 'rename', label: 'Rename', icon: 'edit' },
    { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
    { divider: true },
    { id: 'delete', label: 'Delete', icon: 'trash', destructive: true },
  ];

  readonly suggestionItems: readonly MuiSuggestionItem[] = [
    { id: 'sarah', label: '@sarah', icon: 'person-circle' },
    { id: 'sam', label: '@sam', icon: 'person-circle' },
  ];

  readonly commandItems = [
    { id: 'export', label: 'Export image', icon: 'export' as const, shortcut: '⌘E' },
    { id: 'crop', label: 'Crop', icon: 'tool-crop' as const },
  ];

  // --- 2.5 Structure ---

  readonly collapsibleOpen = signal(true);

  readonly toolbarEntries: readonly MuiToolbarEntry[] = [
    { id: 'undo', icon: 'undo-uturn', label: 'Undo' },
    { id: 'redo', icon: 'redo-uturn', label: 'Redo' },
    { divider: true },
    { id: 'export', icon: 'export', label: 'Export' },
    { id: 'settings', icon: 'gear', label: 'Settings' },
  ];

  readonly bubbleMenuEntries: readonly MuiBubbleMenuEntry[] = [
    { id: 'bold', icon: 'edit', label: 'Bold', active: true },
    { id: 'tag', icon: 'tag', label: 'Highlight' },
    { divider: true },
    { id: 'link', icon: 'share-up-square', label: 'Link' },
  ];

  readonly labelValueRows: readonly MuiLabelValueRow[] = [
    { label: 'Camera', value: 'Sony A7IV' },
    { label: 'ISO', value: '400' },
  ];

  readonly avatarGroupMembers: readonly MuiAvatarGroupMember[] = [
    { name: 'Jules' },
    { name: 'Sarah' },
    { name: 'Sam' },
    { name: 'Kim' },
  ];

  // --- 2.6 Data plots ---
  // Fixed, deterministic sample data (a sum of two sines) — never
  // Math.random, so the showcase renders identically on every load.

  private static bell(bins: number, center: number, spread: number): readonly number[] {
    return Array.from({ length: bins }, (_, i) => {
      const t = i / (bins - 1);
      return Math.exp(-Math.pow((t - center) / spread, 2));
    });
  }

  readonly histogramR = TierMolecules1StructureComponent.bell(40, 0.3, 0.18);
  readonly histogramG = TierMolecules1StructureComponent.bell(40, 0.5, 0.16);
  readonly histogramB = TierMolecules1StructureComponent.bell(40, 0.65, 0.2);

  readonly waveformLuma = Array.from(
    { length: 40 },
    (_, i) => 0.4 + 0.35 * Math.sin(i * 0.35) + 0.15 * Math.sin(i * 0.9),
  );

  readonly paradeR = Array.from({ length: 12 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.6)));
  readonly paradeG = Array.from(
    { length: 12 },
    (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.5 + 1)),
  );
  readonly paradeB = Array.from(
    { length: 12 },
    (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i * 0.7 + 2)),
  );

  readonly vectorscopeSamples: readonly MuiVectorscopeSample[] = Array.from(
    { length: 14 },
    (_, i) => {
      const t = i / 14;
      return {
        r: 0.5 + 0.4 * Math.sin(t * Math.PI * 2),
        g: 0.5 + 0.4 * Math.sin(t * Math.PI * 2 + 2),
        b: 0.5 + 0.4 * Math.cos(t * Math.PI * 2),
      };
    },
  );

  readonly curvePoints = signal<readonly MuiCurvePoint[]>([
    { x: 0, y: 0.05 },
    { x: 0.35, y: 0.25 },
    { x: 0.7, y: 0.85 },
    { x: 1, y: 0.95 },
  ]);

  readonly connectionGraphNodes: readonly MuiConnectionGraphNode[] = [
    { id: 'raw', label: 'RAW', x: 0.15, y: 0.2 },
    { id: 'core', label: 'Core', x: 0.5, y: 0.5 },
    { id: 'wasm', label: 'WASM', x: 0.85, y: 0.2 },
    { id: 'ffi', label: 'FFI', x: 0.25, y: 0.85 },
  ];
  readonly connectionGraphLinks: readonly MuiConnectionGraphLink[] = [
    { source: 'raw', target: 'core' },
    { source: 'core', target: 'wasm' },
    { source: 'core', target: 'ffi' },
  ];

  readonly heatmapGrid: readonly (readonly number[])[] = Array.from({ length: 5 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => {
      const dx = col / 7 - 0.35;
      const dy = row / 4 - 0.5;
      return Math.max(0, 1 - Math.hypot(dx, dy) * 2.2);
    }),
  );

  // --- 2.7 Media ---

  readonly specimenPhoto =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>" +
    "<rect width='80' height='80' fill='%23c4493a'/>" +
    "<circle cx='40' cy='32' r='14' fill='%23422016'/>" +
    "<rect x='16' y='52' width='48' height='20' rx='8' fill='%23422016'/></svg>";
  readonly specimenPhotoBroken = 'data:image/does-not-exist';

  readonly codeBlockSnippet = 'const exposure = 0.0;';
}
