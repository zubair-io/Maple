import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiAdjustmentsPanelComponent,
  MuiBacklinksPanelComponent,
  MuiCollectionGridComponent,
  MuiColorGradingPanelComponent,
  MuiEnrichmentPanelComponent,
  MuiFilmPanelComponent,
  MuiFilmstripComponent,
  MuiFilterPanelComponent,
  MuiHslPanelComponent,
  MuiInfoPanelComponent,
  MuiInspectorPanelComponent,
  MuiKanbanBoardComponent,
  MuiListViewComponent,
  MuiPresetsPanelComponent,
  MuiScopesPanelComponent,
  MuiSearchComponent,
  MuiSearchResultsComponent,
  MuiSidebarComponent,
  MuiThreadPanelComponent,
  MuiTimelineComponent,
  MuiToneCurvePanelComponent,
  MuiToolDockComponent,
  MuiVersionHistoryPanelComponent,
} from '@maple-common';
import type {
  MuiAdjustmentTab,
  MuiBacklinkItem,
  MuiChip,
  MuiCollectionItem,
  MuiContextMenuEntry,
  MuiCurvePoint,
  MuiFilmLook,
  MuiFilmstripItem,
  MuiFilterGroup,
  MuiHslBandValue,
  MuiInfoPanelHistogram,
  MuiKanbanCard,
  MuiKanbanColumn,
  MuiLabelValueRow,
  MuiListViewItem,
  MuiPresetItem,
  MuiScopeSample,
  MuiSidebarNode,
  MuiSidebarSection,
  MuiSuggestionItem,
  MuiTab,
  MuiThreadMessage,
  MuiTimelineGroup,
  MuiToolDockEntry,
  MuiToolbarEntry,
  MuiTranscriptEntry,
  MuiVectorscopeSample,
  MuiVersionItem,
} from '@maple-common';

// Small inline SVG data-URI thumbnail generator, one per index, cycling a
// fixed palette — no network dependency, same convention as
// TierAtomsComponent.specimenPhoto / TierMolecules2Component.specimenPhoto.
// A photo/avatar in this tier is always a generated shape, never an
// external URL, a real filesystem path, or a real person's likeness.
const THUMB_PALETTE = [
  'c4493a',
  '4a7a8c',
  '8c6a4a',
  '5a8c4a',
  '8c4a7a',
  '4a5a8c',
  'a8763a',
  '3a8c78',
] as const;

function thumb(seed: number): string {
  const color = THUMB_PALETTE[seed % THUMB_PALETTE.length];
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>" +
    `<rect width='80' height='80' fill='%23${color}'/>` +
    "<circle cx='40' cy='32' r='14' fill='%23241f1c'/>" +
    "<rect x='16' y='52' width='48' height='20' rx='8' fill='%23241f1c'/></svg>"
  );
}

// Deterministic pseudo-scope data — a fixed sine/triangle mix per channel
// rather than `Math.random()`, so the specimen renders identically on every
// load instead of reshuffling on each page refresh.
function scopeCurve(bins: number, phase: number): readonly number[] {
  return Array.from({ length: bins }, (_, i) =>
    Math.max(0, Math.sin((i / bins) * Math.PI * 2 + phase) * 0.5 + 0.5),
  );
}

function scopeSample(): MuiScopeSample {
  const histogram = {
    r: scopeCurve(32, 0),
    g: scopeCurve(32, 0.6),
    b: scopeCurve(32, 1.3),
  };
  const vectorscope: readonly MuiVectorscopeSample[] = Array.from({ length: 40 }, (_, i) => {
    const t = (i / 40) * Math.PI * 2;
    return {
      r: Math.max(0, Math.min(1, 0.5 + Math.cos(t) * 0.4)),
      g: Math.max(0, Math.min(1, 0.5 + Math.sin(t * 1.3) * 0.3)),
      b: Math.max(0, Math.min(1, 0.5 + Math.sin(t) * 0.4)),
    };
  });
  return {
    histogram,
    waveformLuma: scopeCurve(64, 0.3),
    parade: { r: scopeCurve(64, 0), g: scopeCurve(64, 0.6), b: scopeCurve(64, 1.3) },
    vectorscope,
  };
}

// Organism specimens (collections, navigation, inspectors) — every card
// renders the real `mui-*` organism, composed from the wave 1-5 atoms,
// molecules, and templates, instead of the static Canvas.dc.html mockup
// markup this tier shipped with (same "no drift from the shipped
// implementation" rationale as tier-molecules2). Specimens are backed by
// local component state so selection, drag, expand/collapse, and panel
// edits are all real. Sample data is entirely fabricated: generated SVG
// thumbnails (never an external URL or real file path) and single-letter
// initials for people (never a real person's name), mirroring the
// convention already established by TierMolecules2Component.facesPeople.
@Component({
  selector: 'app-tier-organisms-collections',
  imports: [
    MuiAdjustmentsPanelComponent,
    MuiBacklinksPanelComponent,
    MuiCollectionGridComponent,
    MuiColorGradingPanelComponent,
    MuiEnrichmentPanelComponent,
    MuiFilmPanelComponent,
    MuiFilmstripComponent,
    MuiFilterPanelComponent,
    MuiHslPanelComponent,
    MuiInfoPanelComponent,
    MuiInspectorPanelComponent,
    MuiKanbanBoardComponent,
    MuiListViewComponent,
    MuiPresetsPanelComponent,
    MuiScopesPanelComponent,
    MuiSearchComponent,
    MuiSearchResultsComponent,
    MuiSidebarComponent,
    MuiThreadPanelComponent,
    MuiTimelineComponent,
    MuiToneCurvePanelComponent,
    MuiToolDockComponent,
    MuiVersionHistoryPanelComponent,
  ],
  templateUrl: './tier-organisms-collections.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierOrganismsCollectionsComponent {
  // A fixed reference instant, not a live `Date.now()` — same rationale as
  // TierMolecules2Component.chatSentAt: a live clock would make these
  // specimens silently drift as the page stays open.
  private readonly baseTime = new Date('2026-03-04T14:00:00Z').getTime();

  // --- Collection Grid ---
  readonly collectionGridItems: readonly MuiCollectionItem[] = Array.from(
    { length: 18 },
    (_, i) => ({
      id: `cg${i}`,
      src: thumb(i),
      alt: `Photo ${i + 1}`,
      filename: `IMG_00${i}.NEF`,
      rating: i % 5,
      flag: i === 3 ? 'pick' : i === 7 ? 'reject' : 'none',
    }),
  );
  collectionGridSelected: readonly string[] = ['cg2', 'cg3'];

  // --- List View ---
  readonly listViewItems: readonly MuiListViewItem[] = Array.from({ length: 10 }, (_, i) => ({
    id: `lv${i}`,
    icon: 'photos',
    label: `IMG_00${i}.NEF`,
    subtitle: `${(i % 4) + 1}0MP · RAW`,
  }));
  listViewActiveId: string | null = 'lv2';

  // --- Timeline ---
  readonly timelineFilters: readonly MuiChip[] = [
    { id: 'people', label: 'People' },
    { id: 'places', label: 'Places' },
  ];
  timelineActiveFilterId: string | null = null;
  readonly timelineGroups: readonly MuiTimelineGroup[] = [
    {
      id: 'mar-2026',
      label: 'MARCH 2026',
      items: Array.from({ length: 8 }, (_, i) => ({
        id: `mar${i}`,
        src: thumb(i),
        alt: `March photo ${i + 1}`,
        filename: `IMG_1${i}.NEF`,
      })),
    },
    {
      id: 'feb-2026',
      label: 'FEBRUARY 2026',
      items: Array.from({ length: 5 }, (_, i) => ({
        id: `feb${i}`,
        src: thumb(i + 3),
        alt: `February photo ${i + 1}`,
        filename: `IMG_0${i}.NEF`,
      })),
    },
  ];
  timelineSelected: readonly string[] = [];

  // --- Kanban Board ---
  readonly kanbanColumns: readonly MuiKanbanColumn[] = [
    {
      id: 'todo',
      title: 'To do',
      cards: [
        { id: 'k1', title: 'Cull import batch' } satisfies MuiKanbanCard,
        { id: 'k2', title: 'Tag faces' } satisfies MuiKanbanCard,
      ],
    },
    {
      id: 'doing',
      title: 'Doing',
      cards: [{ id: 'k3', title: 'Ballet recital', src: thumb(0) } satisfies MuiKanbanCard],
    },
    {
      id: 'done',
      title: 'Done',
      cards: [
        { id: 'k4', title: 'Studio portraits', src: thumb(1), badgeLabel: 'Exported' },
        { id: 'k5', title: 'Backup to archive' },
      ] as MuiKanbanCard[],
    },
  ];

  // --- Filmstrip ---
  readonly filmstripItems: readonly MuiFilmstripItem[] = Array.from({ length: 6 }, (_, i) => ({
    id: `fs${i}`,
    src: thumb(i + 2),
    alt: `Frame ${i + 1}`,
  }));
  filmstripActiveId: string | null = 'fs2';

  // --- Search Results ---
  readonly searchResultItems: readonly MuiCollectionItem[] = this.collectionGridItems.slice(0, 8);
  searchResultSelected: readonly string[] = [];

  // --- Sidebar ---
  readonly sidebarSections: readonly MuiSidebarSection[] = [
    {
      id: 'cloud',
      label: 'MAPLE CLOUD',
      nodes: [
        {
          id: 'notebooks',
          label: 'Notebooks',
          icon: 'folder',
          children: [
            { id: 'personal', label: 'Personal', icon: 'folder' },
            { id: 'work', label: 'Work', icon: 'folder' },
          ],
        } satisfies MuiSidebarNode,
      ],
    },
    {
      id: 'local',
      label: 'LOCAL',
      nodes: [{ id: 'journal', label: 'Journal', icon: 'photos' }],
    },
  ];
  sidebarActiveId: string | null = 'personal';
  sidebarExpandedIds: readonly string[] = ['notebooks'];
  readonly sidebarToolbarEntries: readonly MuiToolbarEntry[] = [
    { id: 'add', icon: 'plus', label: 'Add source' },
    { id: 'sort', icon: 'sort', label: 'Sort' },
  ];
  readonly sidebarContextEntries: readonly MuiContextMenuEntry[] = [
    { id: 'rename', label: 'Rename', icon: 'edit' },
    { id: 'delete', label: 'Delete', icon: 'trash', destructive: true },
  ];

  // --- Tool Dock ---
  readonly toolDockEntries: readonly MuiToolDockEntry[] = [
    { id: 'adjust', icon: 'gear', label: 'Adjust' },
    { id: 'color', icon: 'droplet', label: 'Color' },
    { divider: true },
    { id: 'crop', icon: 'split', label: 'Crop' },
    { id: 'retouch', icon: 'edit', label: 'Retouch' },
  ];
  toolDockActiveId: string | null = 'adjust';

  // --- Filter Panel (also reused by Search) ---
  readonly filterGroups: readonly MuiFilterGroup[] = [
    {
      id: 'people',
      label: 'People',
      options: [
        { id: 'a', label: 'A', checked: true },
        { id: 'b', label: 'B', checked: false },
      ],
    },
    {
      id: 'places',
      label: 'Places',
      searchable: true,
      options: [
        { id: 'ridgewood', label: 'Ridgewood, NJ', checked: false },
        { id: 'studio', label: 'Downtown Studio', checked: false },
      ],
    },
  ];
  readonly filterActiveChips: readonly MuiChip[] = [{ id: 'people:a', label: 'A' }];

  // --- Search ---
  searchQuery = 'ballet';
  readonly searchSuggestions: readonly MuiSuggestionItem[] = [
    { id: 'sg1', label: 'ballet recital', icon: 'search' },
    { id: 'sg2', label: 'ballet studio', icon: 'search' },
  ];
  searchShowFilters = true;
  readonly searchResults: readonly MuiCollectionItem[] = this.collectionGridItems.slice(0, 4);
  searchResultSelectedIds: readonly string[] = [];

  // --- Inspector Panel ---
  readonly inspectorTabs: readonly MuiTab[] = [
    { id: 'info', label: 'Info' },
    { id: 'develop', label: 'Develop' },
  ];
  inspectorActiveTabId = 'info';

  // --- Info Panel ---
  infoFilename = 'DSC_0003.NEF';
  readonly infoMetadata: readonly MuiLabelValueRow[] = [
    { label: 'Camera', value: 'Sony A7IV' },
    { label: 'Lens', value: '50mm f/1.4' },
    { label: 'ISO', value: '400' },
  ];
  readonly infoHistogram: MuiInfoPanelHistogram = scopeSample().histogram;
  readonly infoKeywords: readonly MuiChip[] = [
    { id: 'family', label: 'family' },
    { id: '2026', label: '2026' },
  ];
  infoRating = 3;
  infoFlag: 'none' | 'pick' | 'reject' = 'pick';

  // --- Enrichment Panel ---
  enrichmentDescription = 'A dancer stretching outdoors.';
  readonly enrichmentPeople: readonly MuiChip[] = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  enrichmentPlace = 'Ridgewood, NJ';
  readonly enrichmentTranscriptBase = this.baseTime;
  readonly enrichmentTranscriptEntries: readonly MuiTranscriptEntry[] = [
    { id: 't1', offsetMs: 2000, speaker: 'A', text: "Let's reset for another take." },
  ];
  readonly enrichmentVisionLabels: readonly MuiChip[] = [
    { id: 'outdoor', label: 'outdoor' },
    { id: 'portrait', label: 'portrait' },
    { id: 'dance', label: 'dance' },
  ];

  // --- Adjustments Panel ---
  readonly adjustmentTabs: readonly MuiAdjustmentTab[] = [
    {
      id: 'light',
      label: 'Light',
      groups: [
        {
          id: 'tone',
          label: 'Tone',
          sliders: [
            { id: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.1, bipolar: true },
            { id: 'contrast', label: 'Contrast', min: -100, max: 100, bipolar: true },
            { id: 'highlights', label: 'Highlights', min: -100, max: 100, bipolar: true },
            { id: 'shadows', label: 'Shadows', min: -100, max: 100, bipolar: true },
            { id: 'whites', label: 'Whites', min: -100, max: 100, bipolar: true },
            { id: 'blacks', label: 'Blacks', min: -100, max: 100, bipolar: true },
          ],
        },
      ],
    },
    {
      id: 'color',
      label: 'Color',
      groups: [
        {
          id: 'wb',
          label: 'White Balance',
          sliders: [
            { id: 'temp', label: 'Temperature', min: 2000, max: 20000, unit: 'K' },
            { id: 'tint', label: 'Tint', min: -100, max: 100, bipolar: true },
          ],
        },
        {
          id: 'presence',
          label: 'Presence',
          collapsedByDefault: true,
          sliders: [
            { id: 'vibrance', label: 'Vibrance', min: -100, max: 100, bipolar: true },
            { id: 'saturation', label: 'Saturation', min: -100, max: 100, bipolar: true },
            { id: 'clarity', label: 'Clarity', min: -100, max: 100, bipolar: true },
            { id: 'texture', label: 'Texture', min: -100, max: 100, bipolar: true },
            { id: 'dehaze', label: 'Dehaze', min: -100, max: 100, bipolar: true },
          ],
        },
      ],
    },
  ];
  readonly adjustmentValues: Readonly<Record<string, number>> = {
    exposure: 0.3,
    contrast: 12,
    highlights: -20,
    shadows: 15,
    whites: 0,
    blacks: 0,
    temp: 5500,
    tint: 2,
    vibrance: 10,
    saturation: 0,
    clarity: 0,
    texture: 0,
    dehaze: 0,
  };
  adjustmentsActiveTabId = 'light';

  // --- Color Grading Panel ---
  colorGradingShadows = { hue: 220, saturation: 15 };
  colorGradingShadowsLuminance = 0;
  colorGradingMidtones = { hue: 0, saturation: 0 };
  colorGradingMidtonesLuminance = 0;
  colorGradingHighlights = { hue: 40, saturation: 10 };
  colorGradingHighlightsLuminance = 0;
  colorGradingBlending = 50;
  colorGradingBalance = 0;

  // --- HSL Panel ---
  readonly hslValues: Readonly<Record<string, MuiHslBandValue>> = {
    red: { hue: 4, saturation: 8, luminance: 0 },
    orange: { hue: -2, saturation: 0, luminance: 0 },
    yellow: { hue: 0, saturation: 0, luminance: 0 },
    green: { hue: 0, saturation: -6, luminance: 0 },
    aqua: { hue: 0, saturation: 0, luminance: 0 },
    blue: { hue: -3, saturation: 5, luminance: 0 },
    purple: { hue: 0, saturation: 0, luminance: 0 },
    magenta: { hue: 0, saturation: 0, luminance: 0 },
  };
  hslActiveBandId = 'red';

  // --- Tone Curve Panel ---
  readonly toneCurvePoints: Readonly<Record<string, readonly MuiCurvePoint[]>> = {
    rgb: [
      { x: 0, y: 0.05 },
      { x: 0.5, y: 0.55 },
      { x: 1, y: 0.95 },
    ],
    red: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
    green: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
    blue: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ],
  };
  toneCurveActiveChannelId = 'rgb';
  toneCurveHighlights = 0;
  toneCurveLights = 0;
  toneCurveDarks = 0;
  toneCurveShadows = 0;

  // --- Film Panel ---
  readonly filmCategories: readonly MuiChip[] = [
    { id: 'moody', label: 'Moody' },
    { id: 'bright', label: 'Bright & Airy' },
  ];
  readonly filmLooks: readonly MuiFilmLook[] = [
    { id: 'l1', name: 'Look 1', src: thumb(0), category: 'moody' },
    { id: 'l2', name: 'Look 2', src: thumb(1), category: 'moody' },
    { id: 'l3', name: 'Look 3', src: thumb(2), category: 'bright' },
  ];
  filmActiveCategoryId: string | null = null;
  filmSelectedLookId: string | null = 'l1';
  filmStrength = 80;

  // --- Presets Panel ---
  private readonly presetsBase = new Date('2026-03-01T10:00:00Z').getTime();
  readonly presets: readonly MuiPresetItem[] = [
    { id: 'p1', name: 'Moody', updatedAt: this.presetsBase },
    { id: 'p2', name: 'Bright & Airy', updatedAt: this.presetsBase - 3 * 86_400_000 },
    { id: 'p3', name: 'Film Noir', updatedAt: this.presetsBase - 9 * 86_400_000 },
  ];

  // --- Scopes Panel ---
  readonly scopesSample: MuiScopeSample = scopeSample();

  // --- Backlinks Panel ---
  readonly backlinks: readonly MuiBacklinkItem[] = [
    { id: 'bl1', icon: 'folder', label: 'Q3 Planning', subtitle: 'Updated 2d ago' },
    { id: 'bl2', icon: 'folder', label: 'Team Roadmap' },
  ];

  // --- Version History Panel ---
  readonly versions: readonly MuiVersionItem[] = [
    { id: 'v1', label: 'Current edit', timestampValue: this.baseTime, current: true },
    { id: 'v2', label: 'Auto-save', timestampValue: this.baseTime - 86_400_000 },
    { id: 'v3', label: 'Initial import', timestampValue: this.baseTime - 5 * 86_400_000 },
  ];

  // --- Thread Panel ---
  readonly threadMessages: readonly MuiThreadMessage[] = [
    { id: 'm1', author: 'S', sentAt: this.baseTime - 2 * 60_000, text: 'Sounds good, ship it' },
    { id: 'm2', author: 'J', sentAt: this.baseTime - 60_000, text: 'Agreed 👍', own: true },
  ];
  threadDraft = '';
}
