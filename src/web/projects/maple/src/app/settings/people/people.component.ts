// PeopleComponent — `/settings/people` (auth + owner-gated).
//
// Operator surface for the face-cluster identities ("People"), wrapped in
// the shared SettingsShell so it lives alongside Account / Workers / Users.
// `selected()` is the URL-driven detail state — when set, the page renders
// a full-width detail view (header + filter bar + face grid + floating
// selection toolbar) that replaces the list view entirely. When null, the
// list view (page header + stats line + card grid) renders.
//
// The route `/settings/people/:id` deep-links into the detail view. URL
// is the single source of truth: a `selectedRouteId` computed signal
// reads paramMap, and a constructor-time effect fires GET /api/people/:id
// whenever the id changes. Computed signals dedupe by equality, so
// duplicate paramMap emissions for the same id don't re-fetch. Click
// handlers only navigate.
//
// Renaming a person to a name that already exists triggers a SERVER-SIDE
// merge — the response includes `mergedFrom` so the UI can show the
// "Merged into {name}" toast.
//
// Bulk operations (Move / Unassign / Hide) fan out to the existing
// single-face endpoints in parallel and refresh once after settle — the
// API doesn't surface a bulk endpoint yet, and typical selection sizes
// (≤ 60 faces, per the visible cap) make N round-trips acceptable.
//
// Bearer-gated thumb loading lives in {@link ThumbBlobCache} so the
// component stays focused on UI flow control.
//
// Pure derivation (auto-name predicate, sort/filter, face-key plumbing,
// bbox geometry, label copy, error normalisation) lives next door in
// `./people.vm.ts`. This file owns DI, signal wiring, and side effects.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  ApiPerson,
  ApiPersonDetail,
  ApiPersonFace,
  Bbox,
  BunApiBackendService,
  FilesystemBrowseService,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';
import { MapleVisibleOnceDirective } from './visible-once.directive';
import { ThumbBlobCache } from './thumb-blob-cache';
import {
  TOAST_TTL_MS,
  Toast,
  Tone,
  averageConfidence,
  bulkFailureLabel,
  bulkSuccessLabel,
  clusteringSummary,
  deletePersonConfirm,
  errorMessage,
  faceCropTransform,
  faceKey,
  filterNamed,
  hiddenFaceCount,
  isAutoNamed,
  peopleStats,
  pickSelectedFaces,
  selectAllKeys,
  sortPeople,
  toggleSelection,
  visibleFaces,
} from './people.vm';

@Component({
  standalone: true,
  selector: 'maple-people',
  imports: [
    DecimalPipe,
    FormsModule,
    RouterLink,
    SettingsShellComponent,
    SettingsIconComponent,
    MapleVisibleOnceDirective,
  ],
  templateUrl: './people.component.html',
  styleUrl: './people.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeopleComponent implements OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly people = signal<ApiPerson[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly clusteringBusy = signal<boolean>(false);

  readonly selected = signal<ApiPersonDetail | null>(null);
  readonly selectedLoading = signal<boolean>(false);

  readonly editingId = signal<string | null>(null);
  readonly draftName = signal<string>('');

  readonly toast = signal<Toast | null>(null);

  /** Per-face selection set for bulk actions. Keyed by `assetId:faceIndex`
   * so we can intersect with the detail's faces list cleanly. */
  readonly selectedFaces = signal<ReadonlySet<string>>(new Set());

  /** Minimum detector confidence (0-100) for the visible-faces filter.
   * Labelled "Min detector confidence" in the UI — the API's
   * `face.confidence` is RetinaFace's face-likelihood score, NOT cluster-
   * match similarity. The design called this "Min match" / "Similarity";
   * we relabel honestly rather than overload the data. */
  readonly threshold = signal<number>(60);

  /** Hovered face id (for the hover-to-reveal checkbox). Null when no
   * face is hovered. */
  readonly hoveredFace = signal<string | null>(null);

  /** Live in-flight count for bulk operations. While > 0 the floating
   * toolbar disables its buttons to prevent overlapping batches. */
  readonly bulkBusy = signal<number>(0);

  readonly hasPeople = computed(() => this.people().length > 0);

  readonly peopleStats = computed(() => peopleStats(this.people()));

  readonly sortedPeople = computed(() => sortPeople(this.people()));

  readonly namedPeople = computed(() => filterNamed(this.sortedPeople()));

  readonly visibleFaces = computed(() => {
    const detail = this.selected();
    if (!detail) return [];
    return visibleFaces(detail.faces, this.threshold());
  });

  readonly hiddenFaceCount = computed(() => {
    const detail = this.selected();
    if (!detail) return 0;
    return hiddenFaceCount(detail.faces, this.threshold());
  });

  readonly averageConfidence = computed(() => {
    const detail = this.selected();
    return detail ? averageConfidence(detail.faces) : 0;
  });

  /** True when the open detail's name is an auto-assigned "Person N"
   * placeholder. Drives the "Unnamed" chip + plus-icon vs edit-icon. */
  readonly isSelectedAutoNamed = computed(() => {
    const detail = this.selected();
    return detail ? isAutoNamed(detail.name) : false;
  });

  /** Template re-exposure of the auto-name predicate so the list-view
   * card can use the same `^Person N$` rule. */
  protected readonly isAutoName = isAutoNamed;

  /** Template re-exposure of the bbox-crop transform builder. */
  protected readonly faceCropTransform = faceCropTransform;

  /** Bearer-gated thumbnail blob cache. See {@link ThumbBlobCache} for
   * lifecycle / cache-key rules. Created once per component instance. */
  private readonly thumbs = new ThumbBlobCache(this.api, this.fsBrowse);

  /** Route paramMap as a signal — `toSignal` registers a teardown against
   * the component's DestroyRef, so no manual unsubscribe is needed. */
  private readonly routeParamMap = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });

  /** The `:id` segment from the URL, or `null` for `/settings/people`.
   * Computed (reference-stable on equal values) so the detail-fetch
   * effect only fires on actual id changes — replaces the imperative
   * `_lastFetchedId` race guard the previous subscribe() needed. */
  readonly selectedRouteId = computed(() => this.routeParamMap().get('id'));

  constructor() {
    this.refresh();

    // URL → detail fetch. `selectedRouteId` is a computed signal so
    // duplicate paramMap emissions for the same id don't re-fire this.
    // The effect is owned by the component's DestroyRef, so teardown
    // runs automatically on destroy.
    effect(() => {
      const id = this.selectedRouteId();
      if (id) {
        this.openDetail(id);
      } else {
        this.selected.set(null);
        this.selectedFaces.set(new Set());
      }
    });

    // Detail-panel face thumbs prefetch eagerly — the visible-faces grid
    // can be large (up to ~60 visible cells), so paying the network cost
    // up-front keeps scroll snappy. Cover thumbs in the LIST grid are
    // gated by (mapleVisibleOnce) to avoid N requests on first paint.
    effect(() => {
      const detail = this.selected();
      if (!detail) return;
      for (const f of detail.faces) {
        this.thumbs.ensure(f.absPath, f.absPath, f.assetId);
      }
    });
  }

  ngOnDestroy(): void {
    this.thumbs.destroy();
  }

  ensureCoverThumb(p: ApiPerson): void {
    const key = ThumbBlobCache.coverKey(p);
    if (key) this.thumbs.ensure(key, p.coverAbsPath, p.coverAssetId);
  }

  refresh(): void {
    this.loadError.set(null);
    this.api.listPeople().subscribe({
      next: (rows) => this.people.set(rows),
      error: (err) => this.loadError.set(errorMessage(err)),
    });
  }

  selectPerson(id: string): void {
    void this.router.navigate(['/settings/people', id], { replaceUrl: true });
  }

  openDetail(id: string): void {
    this.selectedLoading.set(true);
    this.api.getPerson(id).subscribe({
      next: (detail) => {
        this.selected.set(detail);
        this.selectedFaces.set(new Set());
        this.selectedLoading.set(false);
      },
      error: (err) => {
        this.selectedLoading.set(false);
        this.loadError.set(errorMessage(err));
      },
    });
  }

  /** Re-fetch the open detail after a server-side mutation. If `id`
   * matches the current URL, the route signal won't fire the
   * detail-fetch effect (computed signals dedupe on equality), so call
   * openDetail() directly. Otherwise navigate; the effect picks it up. */
  private refetchDetail(id: string): void {
    if (this.selectedRouteId() === id) {
      this.openDetail(id);
    } else {
      this.selectPerson(id);
    }
  }

  closeDetail(): void {
    void this.router.navigate(['/settings/people'], { replaceUrl: true });
  }

  // ── Rename / inline edit ────────────────────────────────────────────

  startEdit(person: { id: string; name: string }): void {
    this.editingId.set(person.id);
    this.draftName.set(person.name);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.draftName.set('');
  }

  /** The "Merge into…" button on the detail header just kicks the same
   * inline-edit flow as clicking the name — there's no separate merge
   * endpoint, but renaming to an existing name triggers the server-side
   * merge in `renamePerson`. The named-people datalist gives a one-click
   * pick over a free-text rename. */
  triggerMerge(): void {
    const detail = this.selected();
    if (detail) this.startEdit(detail);
  }

  commitEdit(personId: string): void {
    const next = this.draftName().trim();
    if (next.length === 0) {
      this.cancelEdit();
      return;
    }
    const previous = this.people().find((p) => p.id === personId);
    if (previous && previous.name === next) {
      this.cancelEdit();
      return;
    }
    this.api.renamePerson(personId, next).subscribe({
      next: (result) => {
        this.editingId.set(null);
        this.draftName.set('');
        if (result.mergedFrom) {
          this.showToast(`Merged into ${result.name}`, 'success');
        }
        this.refresh();
        const open = this.selected();
        if (open && (open.id === personId || open.id === result.mergedFrom)) {
          this.refetchDetail(result.id);
        }
      },
      error: (err) => {
        this.showToast(errorMessage(err), 'error');
      },
    });
  }

  runClustering(): void {
    this.clusteringBusy.set(true);
    this.api.runClustering().subscribe({
      next: (result) => {
        this.clusteringBusy.set(false);
        this.showToast(clusteringSummary(result), 'success');
        this.refresh();
      },
      error: (err) => {
        this.clusteringBusy.set(false);
        this.showToast(errorMessage(err), 'error');
      },
    });
  }

  async deletePerson(person: ApiPerson): Promise<void> {
    const ok = confirm(deletePersonConfirm(person.name, person.faceCount));
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deletePerson(person.id));
      this.showToast(`Deleted ${person.name}`, 'success');
      if (this.selected()?.id === person.id) this.closeDetail();
      this.refresh();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    }
  }

  /** Detail-header "Delete cluster" — confirms against the open detail. */
  async deleteSelectedCluster(): Promise<void> {
    const detail = this.selected();
    if (!detail) return;
    const matching = this.people().find((p) => p.id === detail.id);
    const faceCount = matching?.faceCount ?? detail.faces.length;
    const ok = confirm(deletePersonConfirm(detail.name, faceCount));
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deletePerson(detail.id));
      this.showToast(`Deleted ${detail.name}`, 'success');
      this.closeDetail();
      this.refresh();
    } catch (err) {
      this.showToast(errorMessage(err), 'error');
    }
  }

  // ── Face selection (bulk) ───────────────────────────────────────────

  faceKey(face: { assetId: string; faceIndex: number }): string {
    return faceKey(face);
  }

  isFaceSelected(face: { assetId: string; faceIndex: number }): boolean {
    return this.selectedFaces().has(faceKey(face));
  }

  toggleFaceSelection(face: { assetId: string; faceIndex: number }): void {
    this.selectedFaces.set(toggleSelection(this.selectedFaces(), face));
  }

  clearSelection(): void {
    this.selectedFaces.set(new Set());
  }

  selectAllVisible(): void {
    this.selectedFaces.set(selectAllKeys(this.visibleFaces()));
  }

  /** Fan one bulk action out over the current selection. `verb` is the
   * past-tense word the toast uses ("Moved", "Unassigned", "Hid") so each
   * action stays grammatically clean without duplicating the try/finally
   * + busy-counter scaffolding.
   *
   * Uses `Promise.allSettled` rather than `Promise.all` so a single
   * per-face failure doesn't abort the whole batch: any face that did
   * succeed is now on a different person / hidden, and skipping the
   * refresh would leave the UI lying about server state. The toast
   * surfaces the success/failure split; failures still flow into the
   * error toast so the operator sees what went wrong. */
  private async bulkApply(
    verb: string,
    fn: (face: ApiPersonFace) => Promise<unknown>,
  ): Promise<void> {
    const faces = pickSelectedFaces(this.selected(), this.selectedFaces());
    if (faces.length === 0) return;
    this.bulkBusy.update((n) => n + 1);
    try {
      const results = await Promise.allSettled(faces.map(fn));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;

      if (ok > 0) {
        this.showToast(bulkSuccessLabel(verb, ok), 'success');
      }
      if (failed > 0) {
        const firstReject = results.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        const reason = firstReject ? errorMessage(firstReject.reason) : 'unknown error';
        this.showToast(bulkFailureLabel(failed, reason), 'error');
      }
    } finally {
      // Always clear selection + refresh, even on partial / total failure
      // — the server state for the successful faces moved, so leaving the
      // UI alone would lie about what's where.
      this.clearSelection();
      const open = this.selected();
      if (open) this.openDetail(open.id);
      this.refresh();
      this.bulkBusy.update((n) => Math.max(0, n - 1));
    }
  }

  bulkMoveTo(personId: string): Promise<void> {
    const target = personId.trim();
    if (!target) return Promise.resolve();
    return this.bulkApply('Moved', (f) =>
      firstValueFrom(this.api.assignFaceToPerson(f.assetId, f.faceIndex, target)),
    );
  }

  bulkUnassign(): Promise<void> {
    return this.bulkApply('Unassigned', (f) =>
      firstValueFrom(this.api.assignFaceToPerson(f.assetId, f.faceIndex, null)),
    );
  }

  bulkHide(): Promise<void> {
    return this.bulkApply('Hid', (f) => firstValueFrom(this.api.hideFace(f.assetId, f.faceIndex)));
  }

  // ── Cover-thumb URL helpers ─────────────────────────────────────────

  coverThumbUrl(person: ApiPerson): string | null {
    return this.thumbs.url(ThumbBlobCache.coverKey(person));
  }

  detailCoverUrl(detail: ApiPersonDetail): string | null {
    const original = this.people().find((p) => p.id === detail.id);
    if (original) return this.coverThumbUrl(original);
    if (!detail.coverAssetId) return null;
    return this.thumbs.url(`apiId:${detail.coverAssetId}`);
  }

  faceThumbUrl(face: ApiPersonFace): string | null {
    return this.thumbs.url(face.absPath);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private showToast(text: string, tone: Tone): void {
    this.toast.set({ text, tone });
    setTimeout(() => {
      const cur = this.toast();
      if (cur && cur.text === text) this.toast.set(null);
    }, TOAST_TTL_MS);
  }
}
