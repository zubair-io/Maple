// PeopleComponent — `/settings/people` (auth + owner-gated).
//
// Operator surface for the face-cluster identities ("People"), wrapped in
// the shared SettingsShell so it lives alongside Account / Workers / Users.
// `selected()` is the URL-driven detail state — when set, the page renders
// a full-width detail view (header + filter bar + face grid + floating
// selection toolbar) that replaces the list view entirely. When null, the
// list view (page header + stats line + card grid) renders.
//
// The route `/settings/people/:id` deep-links into the detail view; the
// paramMap subscription owns the GET /api/people/:id fetch so click
// handlers only navigate (single source of truth for "which person is
// open"). `_lastFetchedId` is a race guard for the click-then-paramMap
// double-fire — the previous (selected().id) check fired before the HTTP
// response landed.
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

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
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

type Tone = 'success' | 'error';

interface Toast {
  text: string;
  tone: Tone;
}

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
export class PeopleComponent implements OnInit, OnDestroy {
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

  /** Stats line for the list view ("12 named · 138 unnamed · 30,142 faces").
   * "Last clustered" is intentionally omitted — the API doesn't surface a
   * timestamp and we won't fabricate one. */
  readonly peopleStats = computed(() => {
    const rows = this.people();
    let named = 0;
    let faces = 0;
    for (const p of rows) {
      if (!isAutoNamed(p.name)) named++;
      faces += p.faceCount;
    }
    return { named, unnamed: rows.length - named, faces };
  });

  readonly sortedPeople = computed(() => {
    const rows = this.people();
    return [...rows].sort((a, b) => {
      const aAuto = isAutoNamed(a.name) ? 1 : 0;
      const bAuto = isAutoNamed(b.name) ? 1 : 0;
      if (aAuto !== bAuto) return aAuto - bAuto;
      if (aAuto === 1) {
        if (a.faceCount !== b.faceCount) return b.faceCount - a.faceCount;
        return a.id.localeCompare(b.id);
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
    });
  });

  readonly namedPeople = computed(() => this.sortedPeople().filter((p) => !isAutoNamed(p.name)));

  /** Visible (threshold-filtered + confidence-sorted) faces of the open
   * detail. Sort is high-confidence-first so the strongest matches anchor
   * the top of the grid. */
  readonly visibleFaces = computed(() => {
    const detail = this.selected();
    if (!detail) return [];
    const min = this.threshold() / 100;
    return detail.faces
      .filter((f) => f.confidence >= min)
      .sort((a, b) => b.confidence - a.confidence);
  });

  /** Faces hidden by the threshold slider — surfaced in the count chip
   * so the operator knows the slider is excluding data. */
  readonly hiddenFaceCount = computed(() => {
    const detail = this.selected();
    if (!detail) return 0;
    return detail.faces.length - this.visibleFaces().length;
  });

  /** Average detector confidence of the open detail's faces, percent.
   * Labelled honestly in the UI ("avg detector confidence") — see the
   * comment on `threshold` re: why "similarity" is the wrong label for
   * this data. */
  readonly averageConfidence = computed(() => {
    const detail = this.selected();
    if (!detail || detail.faces.length === 0) return 0;
    const sum = detail.faces.reduce((acc, f) => acc + f.confidence, 0);
    return Math.round((sum / detail.faces.length) * 100);
  });

  /** True when the open detail's name is an auto-assigned "Person N"
   * placeholder. Drives the "Unnamed" chip + plus-icon vs edit-icon. */
  readonly isSelectedAutoNamed = computed(() => {
    const detail = this.selected();
    return detail ? isAutoNamed(detail.name) : false;
  });

  /** Template helper — exposed so the list-view card can use the same
   * `^Person N$` predicate that drives sort + the detail header. The
   * loose `name.startsWith('Person ')` heuristic miscategorises operator-
   * named clusters like "Person Alice" as auto-named. */
  protected isAutoName(name: string): boolean {
    return isAutoNamed(name);
  }

  /** Bearer-gated thumbnail blob cache. See {@link ThumbBlobCache} for
   * lifecycle / cache-key rules. Created once per component instance. */
  private readonly thumbs = new ThumbBlobCache(this.api, this.fsBrowse);

  ngOnInit(): void {
    this.refresh();
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      if (id) {
        if (this._lastFetchedId === id) return;
        this._lastFetchedId = id;
        this.openDetail(id);
      } else {
        this._lastFetchedId = null;
        this.selected.set(null);
        this.selectedFaces.set(new Set());
      }
    });
  }

  private _lastFetchedId: string | null = null;

  constructor() {
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
      error: (err) => this.loadError.set(this.errorMessage(err)),
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
        this.loadError.set(this.errorMessage(err));
      },
    });
  }

  private refetchDetail(id: string): void {
    this._lastFetchedId = null;
    this.selectPerson(id);
    if (this.selected()?.id === id) {
      this._lastFetchedId = id;
      this.openDetail(id);
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
        this.showToast(this.errorMessage(err), 'error');
      },
    });
  }

  runClustering(): void {
    this.clusteringBusy.set(true);
    this.api.runClustering().subscribe({
      next: (result) => {
        this.clusteringBusy.set(false);
        const summary =
          result.assigned === 0
            ? 'No new faces to assign.'
            : `Assigned ${result.assigned} face${result.assigned === 1 ? '' : 's'} to ${result.newPeople} new person${result.newPeople === 1 ? '' : 's'}.`;
        this.showToast(summary, 'success');
        this.refresh();
      },
      error: (err) => {
        this.clusteringBusy.set(false);
        this.showToast(this.errorMessage(err), 'error');
      },
    });
  }

  async deletePerson(person: ApiPerson): Promise<void> {
    const ok = confirm(
      `Delete "${person.name}"? Their ${person.faceCount} face${person.faceCount === 1 ? '' : 's'} will become unassigned.`,
    );
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deletePerson(person.id));
      this.showToast(`Deleted ${person.name}`, 'success');
      if (this.selected()?.id === person.id) this.closeDetail();
      this.refresh();
    } catch (err) {
      this.showToast(this.errorMessage(err), 'error');
    }
  }

  /** Detail-header "Delete cluster" — confirms against the open detail. */
  async deleteSelectedCluster(): Promise<void> {
    const detail = this.selected();
    if (!detail) return;
    const matching = this.people().find((p) => p.id === detail.id);
    const faceCount = matching?.faceCount ?? detail.faces.length;
    const ok = confirm(
      `Delete "${detail.name}"? Their ${faceCount} face${faceCount === 1 ? '' : 's'} will become unassigned.`,
    );
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deletePerson(detail.id));
      this.showToast(`Deleted ${detail.name}`, 'success');
      this.closeDetail();
      this.refresh();
    } catch (err) {
      this.showToast(this.errorMessage(err), 'error');
    }
  }

  // ── Face selection (bulk) ───────────────────────────────────────────

  faceKey(face: { assetId: string; faceIndex: number }): string {
    return `${face.assetId}:${face.faceIndex}`;
  }

  isFaceSelected(face: { assetId: string; faceIndex: number }): boolean {
    return this.selectedFaces().has(this.faceKey(face));
  }

  toggleFaceSelection(face: { assetId: string; faceIndex: number }): void {
    const key = this.faceKey(face);
    const next = new Set(this.selectedFaces());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.selectedFaces.set(next);
  }

  clearSelection(): void {
    this.selectedFaces.set(new Set());
  }

  selectAllVisible(): void {
    const next = new Set<string>();
    for (const f of this.visibleFaces()) next.add(this.faceKey(f));
    this.selectedFaces.set(next);
  }

  /** Returns the ApiPersonFace objects matching the current selection,
   * intersected with the open detail. Stale keys (from a refresh) are
   * dropped silently. */
  private selectedFaceObjects(): ApiPersonFace[] {
    const detail = this.selected();
    if (!detail) return [];
    const keys = this.selectedFaces();
    return detail.faces.filter((f) => keys.has(this.faceKey(f)));
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
    const faces = this.selectedFaceObjects();
    if (faces.length === 0) return;
    this.bulkBusy.update((n) => n + 1);
    try {
      const results = await Promise.allSettled(faces.map(fn));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;

      if (ok > 0) {
        this.showToast(`${verb} ${ok} face${ok === 1 ? '' : 's'}.`, 'success');
      }
      if (failed > 0) {
        // Surface the first rejection's message — picking one rather than
        // concatenating keeps the toast tight. The remaining failures are
        // implicit in the count.
        const firstReject = results.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        const reason = firstReject ? this.errorMessage(firstReject.reason) : 'unknown error';
        this.showToast(`${failed} face${failed === 1 ? '' : 's'} failed: ${reason}`, 'error');
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

  /** Bbox-crop transform for the face thumb `<img>`. The wrapper is
   * `aspect-square overflow-hidden`; the inner `<img>` is absolute-
   * positioned and we scale + translate so the bbox fills the wrapper.
   * `bbox` is in normalised `[0,1]` proportions of the source image —
   * the face detector emits them this way and they survive end-to-end
   * unchanged. The prototype's `background: center/cover` won't crop to
   * the face; this transform keeps the cover/thumb composed correctly. */
  faceCropTransform(bbox: Bbox): string {
    const { x, y, w, h } = bbox;
    const scaleX = Math.max(1, 1 / Math.max(0.01, w));
    const scaleY = Math.max(1, 1 / Math.max(0.01, h));
    const scale = Math.max(scaleX, scaleY);
    const tx = -x * 100;
    const ty = -y * 100;
    return `scale(${scale}) translate(${tx}%, ${ty}%)`;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private showToast(text: string, tone: Tone): void {
    this.toast.set({ text, tone });
    setTimeout(() => {
      const cur = this.toast();
      if (cur && cur.text === text) this.toast.set(null);
    }, 3500);
  }

  private errorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'error' in err) {
      const inner = (err as { error?: unknown }).error;
      if (inner && typeof inner === 'object' && 'error' in inner) {
        return String((inner as { error: unknown }).error);
      }
      if (typeof inner === 'string') return inner;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

const AUTO_NAME_RE = /^Person \d+$/;

function isAutoNamed(name: string): boolean {
  return AUTO_NAME_RE.test(name);
}
