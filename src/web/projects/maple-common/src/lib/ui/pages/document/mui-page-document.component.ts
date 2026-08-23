// MuiPageDocument — Maple UI Pages (unified-component-catalog.md §6). Split
// Layout: Sidebar (notebook tree) in the sidebar region, Rich Text Editor
// in Center, and a tab-switched Backlinks Panel / Version History Panel in
// Detail.
//
// Cross-organism wiring: selecting a document in the Sidebar swaps the Rich
// Text Editor's content and the Detail region's backlinks/version data —
// every region reflects the same "current document" signal.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiSplitLayoutComponent } from '../../split-layout/mui-split-layout.component';
import { MuiSidebarComponent } from '../../sidebar/mui-sidebar.component';
import type { MuiSidebarSection } from '../../sidebar/mui-sidebar.component';
import { MuiRichTextEditorComponent } from '../../rich-text-editor/mui-rich-text-editor.component';
import { MuiTabsComponent } from '../../tabs/mui-tabs.component';
import type { MuiTab } from '../../tabs/mui-tabs.component';
import { MuiBacklinksPanelComponent } from '../../backlinks-panel/mui-backlinks-panel.component';
import type { MuiBacklinkItem } from '../../backlinks-panel/mui-backlinks-panel.component';
import { MuiVersionHistoryPanelComponent } from '../../version-history-panel/mui-version-history-panel.component';
import type { MuiVersionItem } from '../../version-history-panel/mui-version-history-panel.component';

interface DocRecord {
  readonly id: string;
  readonly label: string;
  readonly content: string;
  readonly backlinks: readonly MuiBacklinkItem[];
  readonly versions: readonly MuiVersionItem[];
}

const BASE_TIME = new Date('2026-03-04T14:00:00Z').getTime();

const DOCS: readonly DocRecord[] = [
  {
    id: 'trip',
    label: 'Trip Planning',
    content: '<p>Flights booked for the 14th. Still need to confirm the cabin.</p>',
    backlinks: [
      { id: 'b1', icon: 'folder', label: 'Coastal Shoot', subtitle: 'Same dates' },
      { id: 'b2', icon: 'folder', label: 'Packing List' },
    ],
    versions: [
      { id: 'v1', label: 'Current edit', timestampValue: BASE_TIME, current: true },
      { id: 'v2', label: 'Auto-save', timestampValue: BASE_TIME - 3_600_000 },
    ],
  },
  {
    id: 'meeting',
    label: 'Meeting Notes',
    content: '<p>Reviewed the fall release scope. Ada to follow up on the export pipeline.</p>',
    backlinks: [{ id: 'b3', icon: 'folder', label: 'Q3 Planning', subtitle: 'Updated 2d ago' }],
    versions: [
      { id: 'v3', label: 'Current edit', timestampValue: BASE_TIME - 86_400_000, current: true },
      { id: 'v4', label: 'Initial draft', timestampValue: BASE_TIME - 3 * 86_400_000 },
    ],
  },
  {
    id: 'recipes',
    label: 'Recipe Box',
    content: '<p>Weeknight dinners: ask Priya for the lentil soup recipe again.</p>',
    backlinks: [],
    versions: [{ id: 'v5', label: 'Current edit', timestampValue: BASE_TIME, current: true }],
  },
];

@Component({
  selector: 'mui-page-document',
  standalone: true,
  imports: [
    MuiSplitLayoutComponent,
    MuiSidebarComponent,
    MuiRichTextEditorComponent,
    MuiTabsComponent,
    MuiBacklinksPanelComponent,
    MuiVersionHistoryPanelComponent,
  ],
  templateUrl: './mui-page-document.component.html',
  styleUrl: './mui-page-document.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageDocumentComponent {
  readonly sidebarSections: readonly MuiSidebarSection[] = [
    {
      id: 'notebooks',
      label: 'NOTEBOOKS',
      nodes: DOCS.map((doc) => ({ id: doc.id, label: doc.label, icon: 'folder' })),
    },
  ];
  readonly sidebarActiveId = signal<string | null>(DOCS[0].id);
  readonly sidebarExpandedIds = signal<readonly string[]>(['notebooks']);

  private readonly activeDoc = computed<DocRecord>(
    () => DOCS.find((doc) => doc.id === this.sidebarActiveId()) ?? DOCS[0],
  );

  readonly editorValue = computed<string>(() => this.activeDoc().content);
  readonly backlinks = computed<readonly MuiBacklinkItem[]>(() => this.activeDoc().backlinks);
  readonly versions = computed<readonly MuiVersionItem[]>(() => this.activeDoc().versions);

  /** Local edits (from the Rich Text Editor) override the doc's stock
   * content until a different document is selected. */
  private readonly edits = signal<Readonly<Record<string, string>>>({});
  readonly displayedValue = computed<string>(
    () => this.edits()[this.sidebarActiveId() ?? ''] ?? this.editorValue(),
  );

  readonly detailTabs: readonly MuiTab[] = [
    { id: 'backlinks', label: 'Backlinks' },
    { id: 'history', label: 'History' },
  ];
  readonly detailActiveTab = signal<string>('backlinks');

  onEditorValueChanged(value: string): void {
    const docId = this.sidebarActiveId();
    if (!docId) return;
    this.edits.update((edits) => ({ ...edits, [docId]: value }));
  }
}
