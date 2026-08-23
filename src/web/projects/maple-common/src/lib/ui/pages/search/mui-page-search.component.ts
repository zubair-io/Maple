// MuiPageSearch — Maple UI Pages (unified-component-catalog.md §6). App
// Shell with the Search organism filling Content.
//
// Cross-organism wiring: the Search organism only renders results — it
// doesn't own a result set. The page holds the mock photo library and
// recomputes `results`/`totalCount` every time the Search organism's query
// changes, so typing (or picking a suggestion) actually narrows what comes
// back, the same round trip the real Search API integration performs.

import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { MuiAppShellComponent } from '../../app-shell/mui-app-shell.component';
import { MuiSearchComponent } from '../../search/mui-search.component';
import type { MuiSuggestionItem } from '../../suggestion-menu/mui-suggestion-menu.component';
import type { MuiFilterGroup } from '../../filter-panel/mui-filter-panel.component';
import type { MuiChip } from '../../chip-row/mui-chip-row.component';
import type { MuiCollectionItem } from '../../collection-grid/mui-collection-grid.component';
import { pageThumb } from '../internal/mock-media';

interface SearchablePhoto extends MuiCollectionItem {
  readonly keywords: readonly string[];
}

const LIBRARY: readonly SearchablePhoto[] = [
  {
    id: 's0',
    src: pageThumb(0),
    alt: 'Ballet recital',
    filename: 'IMG_0031.NEF',
    keywords: ['ballet', 'recital', 'dance'],
  },
  {
    id: 's1',
    src: pageThumb(1),
    alt: 'Ballet studio warmup',
    filename: 'IMG_0032.NEF',
    keywords: ['ballet', 'studio', 'dance'],
  },
  {
    id: 's2',
    src: pageThumb(2),
    alt: 'Wedding first look',
    filename: 'IMG_0033.NEF',
    keywords: ['wedding', 'ortiz'],
  },
  {
    id: 's3',
    src: pageThumb(3),
    alt: 'Wedding reception',
    filename: 'IMG_0034.NEF',
    keywords: ['wedding', 'ortiz', 'reception'],
  },
  {
    id: 's4',
    src: pageThumb(4),
    alt: 'Coastal cliffs at sunset',
    filename: 'IMG_0035.NEF',
    keywords: ['coastal', 'landscape'],
  },
  {
    id: 's5',
    src: pageThumb(5),
    alt: 'Coastal tide pools',
    filename: 'IMG_0036.NEF',
    keywords: ['coastal', 'landscape'],
  },
];

@Component({
  selector: 'mui-page-search',
  standalone: true,
  imports: [MuiAppShellComponent, MuiSearchComponent],
  templateUrl: './mui-page-search.component.html',
  styleUrl: './mui-page-search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiPageSearchComponent {
  readonly query = signal<string>('');
  readonly showFilters = signal<boolean>(true);
  readonly resultSelectedIds = signal<readonly string[]>([]);

  readonly suggestions: readonly MuiSuggestionItem[] = [
    { id: 'sg1', label: 'ballet recital', icon: 'search' },
    { id: 'sg2', label: 'wedding ortiz', icon: 'search' },
  ];
  readonly filterGroups: readonly MuiFilterGroup[] = [
    {
      id: 'subject',
      label: 'Subject',
      options: [
        { id: 'ballet', label: 'Ballet', checked: false },
        { id: 'wedding', label: 'Wedding', checked: false },
        { id: 'coastal', label: 'Coastal', checked: false },
      ],
    },
  ];
  readonly activeChips: readonly MuiChip[] = [];

  readonly results = computed<readonly MuiCollectionItem[]>(() => {
    const words = this.query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return LIBRARY;
    return LIBRARY.filter((photo) => {
      const haystack = `${photo.alt.toLowerCase()} ${photo.keywords.join(' ')}`;
      return words.some((word) => haystack.includes(word));
    });
  });

  readonly totalCount = computed<number>(() => this.results().length);

  onSuggestionSelected(id: string): void {
    const suggestion = this.suggestions.find((s) => s.id === id);
    if (suggestion) this.query.set(suggestion.label);
  }
}
