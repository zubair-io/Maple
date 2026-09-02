// PeopleListComponent — the `/settings/people` list view (page header, stats
// line + small-cluster toggle, empty states, virtual-scroll card grid), split
// out of `PeopleComponent` (#2140) so the detail view isn't dragged along on
// every list-view-only edit.
//
// Presentational: this component owns no server state of its own. It reads
// the already-sorted people list from its parent and renders it; every
// action that reaches the store, the toast, or navigation goes back up to
// `PeopleComponent` via an output. `bulk` (list-selection / merge / hide),
// `coverThumbUrl`/`ensureCoverThumb` (the shared `ThumbBlobCache`), and `crop`
// (the shared `FaceThumbCrop`) are passed down as the SAME instances the
// parent uses for its detail view, so there is exactly one cache of each
// kind — this component does not extend `PeopleGridHost` for those.
//
// It DOES own its own grid geometry: `gridColumns`/`cardWidth`/`rowHeight`
// and the `ResizeObserver` binding, via a private `PeopleGridLayout`
// instance (exported from `people-grid-layout.ts` for exactly this use) —
// the virtual-scroll viewport lives in THIS component's template, so the
// geometry measurement has to live here too.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { RouterLink } from '@angular/router';
import { type ApiPerson, MuiButtonComponent, MuiCheckboxComponent } from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';
import { MapleVisibleOnceDirective } from './visible-once.directive';
import { PeopleGridLayout, bindGridViewport } from './people-grid-layout';
import { FaceThumbCrop } from './face-thumb-crop';
import { PeopleBulkController } from './people-bulk.controller';
import {
  chunkPeopleRows,
  filterSmallClusters,
  isAutoNamed,
  peopleRowKey,
  peopleStats,
  SMALL_CLUSTER_MIN_FACES,
} from './people.vm';

@Component({
  standalone: true,
  selector: 'maple-people-list',
  imports: [
    DecimalPipe,
    RouterLink,
    ScrollingModule,
    SettingsIconComponent,
    MapleVisibleOnceDirective,
    MuiButtonComponent,
    MuiCheckboxComponent,
  ],
  templateUrl: './people-list.component.html',
  styleUrl: './people-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeopleListComponent implements OnDestroy {
  /** Already-sorted people (`sortPeople(people())` on the parent) — named
   * clusters first by descending face count, then auto-named ones. */
  readonly people = input.required<ApiPerson[]>();

  /** List-selection / merge / hide controller — same instance the parent's
   * detail view also reads (its "Merge into…" picker excludes the same
   * selection set), so selection state stays consistent across views. */
  readonly bulk = input.required<PeopleBulkController>();

  readonly clusteringBusy = input.required<boolean>();

  /** Bound to the parent's shared `ThumbBlobCache` — passed as functions
   * rather than the cache itself so this component doesn't need to know
   * the parent's DI shape. */
  readonly coverThumbUrl = input.required<(p: ApiPerson) => string | null>();
  readonly ensureCoverThumb = input.required<(p: ApiPerson) => void>();

  /** Shared with the parent's detail-view face grid — one crop-transform
   * cache for both views. */
  readonly crop = input.required<FaceThumbCrop>();

  readonly selectPerson = output<string>();
  readonly hidePersonRequested = output<ApiPerson>();
  readonly runClustering = output<void>();

  /** Template re-exposure of the auto-name predicate for the card name style. */
  protected readonly isAutoName = isAutoNamed;

  /** Template re-exposure of the face-count floor for the toggle's label +
   * the "all clusters are under N faces" empty state. */
  protected readonly smallClusterMin = SMALL_CLUSTER_MIN_FACES;

  protected readonly hasPeople = computed(() => this.people().length > 0);

  protected readonly peopleStats = computed(() => peopleStats(this.people()));

  /** "Hide small clusters" toggle — on by default so the long tail of tiny
   * stray-detection clusters doesn't bury the real identities. */
  protected readonly hideSmallClusters = signal<boolean>(true);

  /** The rows the GRID renders. `peopleStats` deliberately stays on the
   * unfiltered list — hiding a cluster from the grid must not change the
   * whole-library summary. */
  protected readonly visiblePeople = computed(() =>
    this.hideSmallClusters()
      ? filterSmallClusters(this.people(), SMALL_CLUSTER_MIN_FACES)
      : this.people(),
  );

  /** How many rows the toggle is currently hiding — surfaced next to it so
   * nothing disappears silently. */
  protected readonly hiddenSmallCount = computed(
    () => this.people().length - this.visiblePeople().length,
  );

  // ── Virtual scroll ───────────────────────────────────────────────────
  // Windowed by `cdk-virtual-scroll-viewport`: sorted people are packed into
  // fixed-height rows of `gridColumns()` cards (see the row-packing helpers
  // in people.vm.ts) and the ROWS are virtualised. The `(mapleVisibleOnce)`
  // cover-lazy-load still fires per card as rows mount.

  /** Own grid-geometry + ResizeObserver instance (not the parent's — that
   * one is unused now that the viewport moved here). */
  private readonly layout = new PeopleGridLayout();
  protected readonly gridColumns = this.layout.gridColumns;
  protected readonly cardWidth = this.layout.cardWidth;
  protected readonly rowHeight = this.layout.rowHeight;
  protected readonly gridGap = this.layout.gridGap;

  /** Virtual-scroll viewport host. Signal query (not a static ViewChild)
   * because it lives in a conditional template block — only present once
   * there's a non-empty visible list — and re-appears on toggling the
   * small-cluster filter back on. */
  private readonly peopleScrollContent = viewChild('peopleScrollContent', { read: ElementRef });

  /** Sorted people packed into fixed-width rows for the virtual viewport. */
  protected readonly peopleRows = computed(() =>
    chunkPeopleRows(this.visiblePeople(), this.gridColumns()),
  );

  /** Track-by for virtualised rows (see `peopleRowKey`). */
  protected trackRow = peopleRowKey;

  constructor() {
    bindGridViewport(this.layout, this.peopleScrollContent);
  }

  ngOnDestroy(): void {
    this.layout.disconnect();
  }
}
