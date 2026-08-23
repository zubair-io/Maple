// MuiPageTvTimeline — Maple UI Pages (unified-component-catalog.md §6). Tab
// Shell switching Content between the Timeline organism and the Collection
// Grid organism.
//
// Cross-organism wiring: the Timeline's filter chip selection is a single
// signal shared by both organisms — switching from the Timeline tab to the
// Collections tab keeps whatever "People"/"Places" filter was active,
// instead of each organism keeping its own independent, silently
// diverging copy.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiTabShellComponent } from '../../tab-shell/mui-tab-shell.component';
import type { MuiTab } from '../../tabs/mui-tabs.component';
import { MuiTimelineComponent } from '../../timeline/mui-timeline.component';
import type { MuiTimelineGroup } from '../../timeline/mui-timeline.component';
import { MuiCollectionGridComponent } from '../../collection-grid/mui-collection-grid.component';
import type { MuiCollectionItem } from '../../collection-grid/mui-collection-grid.component';
import type { MuiChip } from '../../chip-row/mui-chip-row.component';
import { pageThumb } from '../internal/mock-media';

interface TvPhoto extends MuiCollectionItem {
  readonly month: string;
  readonly tag: 'people' | 'places' | null;
}

const PHOTOS: readonly TvPhoto[] = [
  {
    id: 't0',
    src: pageThumb(0),
    alt: 'Ballet recital',
    filename: 'IMG_10.NEF',
    month: 'MARCH 2026',
    tag: 'people',
  },
  {
    id: 't1',
    src: pageThumb(1),
    alt: 'Family dinner',
    filename: 'IMG_11.NEF',
    month: 'MARCH 2026',
    tag: 'people',
  },
  {
    id: 't2',
    src: pageThumb(2),
    alt: 'Coastal cliffs',
    filename: 'IMG_12.NEF',
    month: 'MARCH 2026',
    tag: 'places',
  },
  {
    id: 't3',
    src: pageThumb(3),
    alt: 'Studio portrait',
    filename: 'IMG_13.NEF',
    month: 'FEBRUARY 2026',
    tag: 'people',
  },
  {
    id: 't4',
    src: pageThumb(4),
    alt: 'Downtown skyline',
    filename: 'IMG_14.NEF',
    month: 'FEBRUARY 2026',
    tag: 'places',
  },
];

@Component({
  selector: 'mui-page-tv-timeline',
  standalone: true,
  imports: [MuiTabShellComponent, MuiTimelineComponent, MuiCollectionGridComponent],
  templateUrl: './mui-page-tv-timeline.component.html',
  styleUrl: './mui-page-tv-timeline.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageTvTimelineComponent {
  readonly tabs: readonly MuiTab[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'collections', label: 'Collections' },
  ];
  readonly activeTabId = signal<string>('timeline');

  readonly filters: readonly MuiChip[] = [
    { id: 'people', label: 'People' },
    { id: 'places', label: 'Places' },
  ];
  readonly activeFilterId = signal<string | null>(null);

  private readonly visiblePhotos = computed<readonly TvPhoto[]>(() => {
    const filter = this.activeFilterId();
    return filter ? PHOTOS.filter((photo) => photo.tag === filter) : PHOTOS;
  });

  readonly timelineGroups = computed<readonly MuiTimelineGroup[]>(() => {
    const byMonth = new Map<string, TvPhoto[]>();
    for (const photo of this.visiblePhotos()) {
      const group = byMonth.get(photo.month) ?? [];
      group.push(photo);
      byMonth.set(photo.month, group);
    }
    return Array.from(byMonth, ([label, items]) => ({ id: label, label, items }));
  });

  readonly collectionItems = computed<readonly MuiCollectionItem[]>(() => this.visiblePhotos());
  readonly collectionSelectedIds = signal<readonly string[]>([]);
}
