// MuiPageBrowse — Maple UI Pages (unified-component-catalog.md §6). Split
// Layout hosting Sidebar (folders), a view-switching Toolbar, and — per the
// active toolbar selection — Collection Grid, Timeline, or Map Surface in
// the Center region. No Detail region (Browse has nothing to put there;
// that's what the Editor/Inspector page is for).
//
// Cross-organism wiring: selecting a folder in the Sidebar filters which
// photos the Center region shows (`visiblePhotos`), in whichever view is
// active; the Toolbar's view-switch buttons drive which organism renders in
// Center at all. Both are plain signals read from the child outputs, not
// child state read back out — the same shape every other page in this wave
// uses.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiSplitLayoutComponent } from '../../split-layout/mui-split-layout.component';
import { MuiSidebarComponent } from '../../sidebar/mui-sidebar.component';
import type { MuiSidebarSection } from '../../sidebar/mui-sidebar.component';
import { MuiToolbarComponent } from '../../toolbar/mui-toolbar.component';
import type { MuiToolbarEntry } from '../../toolbar/mui-toolbar.component';
import { MuiCollectionGridComponent } from '../../collection-grid/mui-collection-grid.component';
import type { MuiCollectionItem } from '../../collection-grid/mui-collection-grid.component';
import { MuiTimelineComponent } from '../../timeline/mui-timeline.component';
import type { MuiTimelineGroup } from '../../timeline/mui-timeline.component';
import { MuiMapSurfaceComponent } from '../../map-surface/mui-map-surface.component';
import type { MuiMapAnnotationInput } from '../../map-surface/mui-map-surface.component';
import { pageThumb } from '../internal/mock-media';

export type MuiPageBrowseView = 'grid' | 'timeline' | 'map';

interface BrowsePhoto extends MuiCollectionItem {
  readonly folderId: string;
}

const FOLDERS = ['ballet', 'wedding', 'coastal'] as const;
const FOLDER_LABELS: Readonly<Record<(typeof FOLDERS)[number], string>> = {
  ballet: 'Ballet Session',
  wedding: 'Wedding — Ortiz',
  coastal: 'Coastal Shoot',
};

function buildPhotos(): readonly BrowsePhoto[] {
  return FOLDERS.flatMap((folderId, folderIndex) =>
    Array.from({ length: 6 }, (_, i) => {
      const seed = folderIndex * 6 + i;
      return {
        id: `${folderId}-${i}`,
        folderId,
        src: pageThumb(seed),
        alt: `${FOLDER_LABELS[folderId]} photo ${i + 1}`,
        filename: `IMG_${(1000 + seed).toString().slice(1)}.NEF`,
        rating: (i % 5) as number,
        flag: i === 1 ? 'pick' : 'none',
      } satisfies BrowsePhoto;
    }),
  );
}

@Component({
  selector: 'mui-page-browse',
  standalone: true,
  imports: [
    MuiSplitLayoutComponent,
    MuiSidebarComponent,
    MuiToolbarComponent,
    MuiCollectionGridComponent,
    MuiTimelineComponent,
    MuiMapSurfaceComponent,
  ],
  templateUrl: './mui-page-browse.component.html',
  styleUrl: './mui-page-browse.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageBrowseComponent {
  private readonly allPhotos = buildPhotos();

  readonly sidebarSections: readonly MuiSidebarSection[] = [
    {
      id: 'library',
      label: 'LIBRARY',
      nodes: FOLDERS.map((id) => ({ id, label: FOLDER_LABELS[id], icon: 'folder' })),
    },
  ];
  readonly sidebarActiveId = signal<string | null>('ballet');
  readonly sidebarExpandedIds = signal<readonly string[]>(['library']);

  readonly viewToolbarEntries: readonly MuiToolbarEntry[] = [
    { id: 'grid', icon: 'grid-lg', label: 'Grid' },
    { id: 'timeline', icon: 'history', label: 'Timeline' },
    { id: 'map', icon: 'map-pin', label: 'Map' },
  ];
  readonly activeView = signal<MuiPageBrowseView>('grid');

  readonly gridSelectedIds = signal<readonly string[]>([]);

  /** The Sidebar's active folder filters every view, not just the grid —
   * this is the one piece of state all three Center views read. */
  readonly visiblePhotos = computed<readonly MuiCollectionItem[]>(() =>
    this.allPhotos.filter((photo) => photo.folderId === this.sidebarActiveId()),
  );

  readonly timelineGroups = computed<readonly MuiTimelineGroup[]>(() => {
    const folderId = this.sidebarActiveId();
    const label = folderId ? (FOLDER_LABELS[folderId as (typeof FOLDERS)[number]] ?? '') : '';
    return [{ id: `${folderId}-group`, label: label.toUpperCase(), items: this.visiblePhotos() }];
  });

  readonly mapAnnotations = computed<readonly MuiMapAnnotationInput[]>(() =>
    this.visiblePhotos().map((photo, i) => ({
      id: photo.id,
      x: 0.2 + ((i * 0.11) % 0.6),
      y: 0.25 + ((i * 0.17) % 0.5),
      label: photo.alt,
    })),
  );

  onViewSelected(id: string): void {
    this.activeView.set(id as MuiPageBrowseView);
  }
}
