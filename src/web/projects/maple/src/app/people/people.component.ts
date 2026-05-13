// PeopleComponent — `/people` (auth + owner-gated).
//
// Operator surface for the face-cluster identities ("People"). The page
// has two states wired through one signal — `selected()` either points
// at a person (detail view in a side panel) or is null (list view only).
//
//   - List view: grid of person cards (cover thumb + inline-editable
//     name + face count + delete affordance) and a "Run clustering"
//     button at the top.
//   - Detail view: side panel of up to 50 face thumbnails. Each face
//     has a dropdown to move to another person + an "Unassign" button.
//
// Renaming a person to a name that already exists triggers a SERVER-SIDE
// merge — the response includes `mergedFrom` so the UI can show the
// "Merged into {name}" toast.

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
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
import { MapleVisibleOnceDirective } from './visible-once.directive';

type Tone = 'success' | 'error';

interface Toast {
  text: string;
  tone: Tone;
}

@Component({
  standalone: true,
  selector: 'maple-people',
  imports: [DecimalPipe, FormsModule, RouterLink, MapleVisibleOnceDirective],
  templateUrl: './people.component.html',
  styleUrl: './people.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeopleComponent implements OnInit, OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** Live list of people. Refreshed on init, after clustering, after
   * rename / delete. */
  readonly people = signal<ApiPerson[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly clusteringBusy = signal<boolean>(false);

  /** Currently-selected person for the detail panel, or null when the
   * list view fills the page. */
  readonly selected = signal<ApiPersonDetail | null>(null);
  readonly selectedLoading = signal<boolean>(false);

  /** Inline-edit state — the id of the person whose name field is in
   * edit mode, plus the draft text. `null` = nobody is editing. */
  readonly editingId = signal<string | null>(null);
  readonly draftName = signal<string>('');

  /** Transient toast (rename merge confirmation, delete confirmation). */
  readonly toast = signal<Toast | null>(null);

  readonly hasPeople = computed(() => this.people().length > 0);

  /** Display order: named people first, then auto-named ("Person N")
   * second, each group ascending case-insensitively. Computed off
   * `people()` so renames re-sort in real time (the rename handler
   * updates `people` after the server roundtrip; the computed re-runs
   * automatically). */
  readonly sortedPeople = computed(() => {
    const rows = this.people();
    const auto = /^Person \d+$/;
    return [...rows].sort((a, b) => {
      const aAuto = auto.test(a.name) ? 1 : 0;
      const bAuto = auto.test(b.name) ? 1 : 0;
      if (aAuto !== bAuto) return aAuto - bAuto;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
    });
  });

  /** Cache key (`absPath` when present, otherwise `apiId:<id>`) → `blob:`
   * URL of the fetched thumbnail JPEG.
   *
   * Direct `<img src=/api/assets/:id/thumb>` bypasses Angular's HttpClient
   * and so doesn't get the Bearer token from `authInterceptor` — the API
   * would 401. We fetch via HttpClient (interceptor attaches the bearer)
   * and hand the template a `blob:` URL the browser can render with no
   * extra auth. The absPath path delegates to {@link FilesystemBrowseService}
   * so the URL is shared with /browse's grid (same `/api/fs/thumb?path=…`
   * URL → same in-memory blob, same browser HTTP cache entry). */
  private readonly thumbBlobs = signal<ReadonlyMap<string, string>>(new Map());
  /** Cache keys currently being fetched — prevents duplicate round-trips
   * when the template re-evaluates a binding before the response lands. */
  private readonly inflightThumbs = new Set<string>();
  /** Blob URLs we minted via `URL.createObjectURL` (the `/api/assets/:id/thumb`
   * orphan-cover fallback). Tracked so we can revoke on destroy and not
   * leak. URLs returned from `FilesystemBrowseService.getThumbBlobUrl`
   * are owned by that singleton and we deliberately don't revoke them. */
  private readonly ownedBlobUrls = new Set<string>();

  ngOnInit(): void {
    this.refresh();
    // Single source of truth for "which person is open" is the URL.
    // Click handlers navigate via `selectPerson()`; only this subscription
    // fetches /api/people/:id. Tracking `_lastFetchedId` separately rather
    // than checking `selected()?.id` (which only updates *after* the HTTP
    // response — a click-then-paramMap race would otherwise re-fetch).
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      if (id) {
        if (this._lastFetchedId === id) return;
        this._lastFetchedId = id;
        this.openDetail(id);
      } else {
        this._lastFetchedId = null;
        this.selected.set(null);
      }
    });
  }

  /** Last person id we kicked a `getPerson()` for. Tracked separately
   * from `selected()` because the latter doesn't update until the HTTP
   * response lands — a same-tick re-emit of `paramMap` would race and
   * re-fetch. */
  private _lastFetchedId: string | null = null;

  constructor() {
    // Detail-panel face thumbs prefetch eagerly — there's a 30-row cap
    // and most are visible inside the panel scroll area, so paying the
    // network cost up-front keeps the panel snappy when the user scrolls
    // it. Cover thumbs in the *grid* don't prefetch here — they're gated
    // by the (mapleVisibleOnce) directive in the template so off-screen
    // cards don't kick off N HTTP requests when /api/people lands.
    effect(() => {
      const detail = this.selected();
      if (!detail) return;
      for (const f of detail.faces) {
        this.ensureThumbBlob(f.absPath, f.absPath, f.assetId);
      }
    });
  }

  ngOnDestroy(): void {
    for (const url of this.ownedBlobUrls) URL.revokeObjectURL(url);
    this.ownedBlobUrls.clear();
  }

  /** Called from the template when a card scrolls into the viewport
   * (`(mapleVisibleOnce)`). Idempotent — repeat fires no-op via the
   * inflight + cache guards inside {@link ensureThumbBlob}. */
  ensureCoverThumb(p: ApiPerson): void {
    const key = this.coverCacheKey(p);
    if (key) this.ensureThumbBlob(key, p.coverAbsPath, p.coverAssetId);
  }

  /** Chooses the cache key for a person's cover. Prefer `absPath` so the
   * blob URL is shared with /browse; fall back to a synthetic `apiId:`
   * key when the cover asset doc was deleted (covers fetched via
   * `/api/assets/:id/thumb` instead). */
  private coverCacheKey(p: { coverAbsPath: string | null; coverAssetId: string | null }): string | null {
    if (p.coverAbsPath) return p.coverAbsPath;
    if (p.coverAssetId) return `apiId:${p.coverAssetId}`;
    return null;
  }

  /** Idempotently load the blob URL for a thumb keyed by `cacheKey`. When
   * `absPath` is set we delegate to `FilesystemBrowseService.getThumbBlobUrl`
   * (singleton cache, shared with /browse). Otherwise we fall back to the
   * api-id endpoint, which doesn't share with /browse but covers the
   * orphan case where the asset doc has been deleted. */
  private ensureThumbBlob(
    cacheKey: string,
    absPath: string | null,
    apiAssetId: string | null,
  ): void {
    if (!cacheKey) return;
    if (this.inflightThumbs.has(cacheKey)) return;
    // `untracked` so adding a new blob URL doesn't re-trigger the caller
    // effect — only `people()` / `selected()` changes should.
    if (untracked(this.thumbBlobs).has(cacheKey)) return;
    this.inflightThumbs.add(cacheKey);

    // Match the size /browse asks for (asset-thumb passes 512) so the
    // cache key (absPath) resolves to the same blob entry — otherwise
    // whichever route loads first wins and the other route gets the
    // wrong-resolution thumb. fsBrowse caches by absPath only.
    const promise: Promise<{ url: string; owned: boolean }> = absPath
      ? this.fsBrowse.getThumbBlobUrl(absPath, 512).then((url) => ({ url, owned: false }))
      : apiAssetId
        ? firstValueFrom(this.api.getThumb(apiAssetId)).then((b) => ({
            url: URL.createObjectURL(b),
            owned: true,
          }))
        : Promise.reject(new Error('no asset reference'));

    promise
      .then(({ url, owned }) => {
        this.inflightThumbs.delete(cacheKey);
        if (owned) this.ownedBlobUrls.add(url);
        const next = new Map(untracked(this.thumbBlobs));
        next.set(cacheKey, url);
        this.thumbBlobs.set(next);
      })
      .catch(() => {
        this.inflightThumbs.delete(cacheKey);
      });
  }

  refresh(): void {
    this.loadError.set(null);
    this.api.listPeople().subscribe({
      next: (rows) => this.people.set(rows),
      error: (err) => this.loadError.set(this.errorMessage(err)),
    });
  }

  /** Click handler — only navigates. The paramMap subscription owns the
   * fetch (single source of truth). Calling this when the person is
   * already selected is a no-op (router skips same-URL navigation). */
  selectPerson(id: string): void {
    void this.router.navigate(['/people', id], { replaceUrl: true });
  }

  /** Internal — kicks off the GET /api/people/:id. Always called from
   * the paramMap subscription. Doesn't touch the URL. */
  openDetail(id: string): void {
    this.selectedLoading.set(true);
    this.api.getPerson(id).subscribe({
      next: (detail) => {
        this.selected.set(detail);
        this.selectedLoading.set(false);
      },
      error: (err) => {
        this.selectedLoading.set(false);
        this.loadError.set(this.errorMessage(err));
      },
    });
  }

  /** Force a re-fetch of the open detail (e.g. after rename, assign,
   * unassign — the data went stale). Bypasses the paramMap dedupe by
   * resetting `_lastFetchedId` and re-firing through `selectPerson()` so
   * the URL stays in sync (no-op for same-id refresh; real navigation
   * for the merge survivor case). */
  private refetchDetail(id: string): void {
    this._lastFetchedId = null;
    this.selectPerson(id);
    // selectPerson just navigates; for same-id case the router skips the
    // emit, so call openDetail() directly to actually refetch.
    if (this.selected()?.id === id) {
      this._lastFetchedId = id;
      this.openDetail(id);
    }
  }

  closeDetail(): void {
    void this.router.navigate(['/people'], { replaceUrl: true });
  }

  // ── Rename / inline edit ────────────────────────────────────────────

  startEdit(person: ApiPerson): void {
    this.editingId.set(person.id);
    this.draftName.set(person.name);
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.draftName.set('');
  }

  /** Commit the inline rename. Server runs the merge logic; we surface
   * the "Merged into {name}" toast when `mergedFrom` is set. */
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
        // If we merged, the open detail might be the orphan — re-open
        // the survivor if the URL still points at the orphan.
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

  // ── Run clustering ──────────────────────────────────────────────────

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

  // ── Delete ──────────────────────────────────────────────────────────

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

  // ── Face panel actions ──────────────────────────────────────────────

  /** Move a face to a different person via the dropdown. */
  moveFaceTo(face: { assetId: string; faceIndex: number }, personId: string): void {
    const target = personId.trim();
    if (target.length === 0) return;
    this.api.assignFaceToPerson(face.assetId, face.faceIndex, target).subscribe({
      next: () => {
        const open = this.selected();
        if (open) this.refetchDetail(open.id);
        this.refresh();
      },
      error: (err) => this.showToast(this.errorMessage(err), 'error'),
    });
  }

  unassignFace(face: { assetId: string; faceIndex: number }): void {
    this.api.assignFaceToPerson(face.assetId, face.faceIndex, null).subscribe({
      next: () => {
        const open = this.selected();
        if (open) this.openDetail(open.id);
        this.refresh();
      },
      error: (err) => this.showToast(this.errorMessage(err), 'error'),
    });
  }

  /** Mark a face as hidden — removes it from the current person panel,
   * the clustering pool, and every other person's panel. Unlike
   * `unassignFace` (which sends the face back to the unassigned pool
   * for the next clustering run to pick up), Hide is sticky: the face
   * stays out until a future "Show hidden" toggle restores it. */
  hideFace(face: { assetId: string; faceIndex: number }): void {
    this.api.hideFace(face.assetId, face.faceIndex).subscribe({
      next: () => {
        const open = this.selected();
        if (open) this.openDetail(open.id);
        this.refresh();
      },
      error: (err) => this.showToast(this.errorMessage(err), 'error'),
    });
  }

  // ── Cover-thumb URL helpers ─────────────────────────────────────────

  /** Cover-thumb `blob:` URL or `null` if the fetch hasn't landed yet
   * (template falls back to the initial letter). */
  coverThumbUrl(person: ApiPerson): string | null {
    const key = this.coverCacheKey(person);
    if (!key) return null;
    return this.thumbBlobs().get(key) ?? null;
  }

  /** Cover image for the detail-panel header. Reuses the same blob URL
   * the grid card already loaded — looks up the original ApiPerson by id
   * so we hit the same cache key (absPath when available). */
  detailCoverUrl(detail: ApiPersonDetail): string | null {
    const original = this.people().find((p) => p.id === detail.id);
    if (original) return this.coverThumbUrl(original);
    if (!detail.coverAssetId) return null;
    return this.thumbBlobs().get(`apiId:${detail.coverAssetId}`) ?? null;
  }

  /** Face-thumb `blob:` URL for the detail panel, or `null` while the
   * fetch is in flight (the wrapper div renders its placeholder bg). */
  faceThumbUrl(face: ApiPersonFace): string | null {
    return this.thumbBlobs().get(face.absPath) ?? null;
  }

  /** Bbox-crop transform for the face thumb `<img>`. The wrapper div is
   * `aspect-square overflow-hidden`; the inner `<img>` is absolute-
   * positioned and we scale + translate it so the bbox fills the wrapper.
   * Same arithmetic the previous `background-size`/`background-position`
   * trick used, expressed as a `transform` so we can put the URL on a
   * native `<img loading="lazy">` instead of a background-image div.
   *
   * `bbox` is in normalised `[0,1]` proportions of the source image —
   * the face detector emits them this way (see
   * `api/enrichment/face-detector.ts`) and they survive end-to-end
   * unchanged.
   *
   * NOTE: this assumes the bbox shares the thumb's aspect ratio (it
   * does — the face detector ran on the same thumbnail). For library
   * photos with weird aspect ratios the crop is approximate but
   * recognisable.
   */
  faceCropTransform(bbox: Bbox): string {
    const { x, y, w, h } = bbox;
    // Clamp to 0.01 to avoid divide-by-zero on bad data.
    const scaleX = Math.max(1, 1 / Math.max(0.01, w));
    const scaleY = Math.max(1, 1 / Math.max(0.01, h));
    const scale = Math.max(scaleX, scaleY);
    // Translate first (in source-image %) then scale around the origin so
    // the bbox top-left ends up at (0, 0). Equivalent to the bg-position%
    // form, just expressed as a transform.
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
