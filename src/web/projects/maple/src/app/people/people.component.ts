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
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgStyle } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  ApiPerson,
  ApiPersonDetail,
  Bbox,
  BunApiBackendService,
} from '@maple-common';

type Tone = 'success' | 'error';

interface Toast {
  text: string;
  tone: Tone;
}

@Component({
  standalone: true,
  selector: 'maple-people',
  imports: [FormsModule, NgStyle, RouterLink],
  templateUrl: './people.component.html',
  styleUrl: './people.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeopleComponent implements OnInit, OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

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

  /** assetId → `blob:` URL of the fetched thumbnail JPEG.
   *
   * Direct `<img src=/api/assets/:id/thumb>` and `background-image: url(...)`
   * bypass Angular's HttpClient and so don't get the Bearer token from
   * `authInterceptor` — the API would 401 every request. We fetch each
   * thumb via HttpClient (interceptor attaches the bearer) and hand the
   * template a `blob:` URL the browser can render with no extra auth. */
  private readonly thumbBlobs = signal<ReadonlyMap<string, string>>(new Map());
  /** assetIds currently being fetched — prevents duplicate round-trips when
   * the template re-evaluates a binding before the response lands. */
  private readonly inflightThumbs = new Set<string>();

  ngOnInit(): void {
    this.refresh();
    // Deep-link support: `/people/:id` opens the detail panel for that
    // person on first paint.
    this.route.paramMap.subscribe((params) => {
      const id = params.get('id');
      if (id) this.openDetail(id);
      else this.selected.set(null);
    });
  }

  ngOnDestroy(): void {
    for (const url of this.thumbBlobs().values()) URL.revokeObjectURL(url);
  }

  constructor() {
    // Prefetch every visible thumbnail (cover thumbs in the grid + face
    // thumbs in the open detail panel). Reads of `people()` / `selected()`
    // make this re-run when the list or open person changes; the
    // `inflightThumbs` + blob-cache guard inside `ensureThumbBlob` dedupes
    // repeat asset ids.
    effect(() => {
      for (const p of this.people()) {
        if (p.coverAssetId) this.ensureThumbBlob(p.coverAssetId);
      }
      const detail = this.selected();
      if (detail) {
        for (const f of detail.faces) this.ensureThumbBlob(f.assetId);
      }
    });
  }

  private ensureThumbBlob(assetId: string): void {
    if (!assetId) return;
    if (this.inflightThumbs.has(assetId)) return;
    // `untracked` so adding a new blob URL doesn't re-trigger the caller
    // effect — only `people()` / `selected()` changes should.
    if (untracked(this.thumbBlobs).has(assetId)) return;
    this.inflightThumbs.add(assetId);
    // `takeUntilDestroyed` so an in-flight thumb fetch that lands after the
    // user navigates away can't (a) allocate a new blob URL that escapes the
    // `ngOnDestroy` revocation pass or (b) write to a torn-down signal.
    this.api
      .getThumb(assetId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (blob) => {
          this.inflightThumbs.delete(assetId);
          const url = URL.createObjectURL(blob);
          const next = new Map(untracked(this.thumbBlobs));
          next.set(assetId, url);
          this.thumbBlobs.set(next);
        },
        error: () => {
          this.inflightThumbs.delete(assetId);
        },
      });
  }

  refresh(): void {
    this.loadError.set(null);
    this.api.listPeople().subscribe({
      next: (rows) => this.people.set(rows),
      error: (err) => this.loadError.set(this.errorMessage(err)),
    });
  }

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
    // Reflect the open detail in the URL so the back button works.
    void this.router.navigate(['/people', id], { replaceUrl: true });
  }

  closeDetail(): void {
    this.selected.set(null);
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
          this.openDetail(result.id);
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
        if (open) this.openDetail(open.id);
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

  // ── Cover-thumb URL helper ──────────────────────────────────────────

  /** Cover-thumb `blob:` URL or `null` if the fetch hasn't landed yet
   * (template falls back to the initial letter). `coverAssetId` is the
   * asset whose thumb represents the person; the CSS bbox crop on the
   * wrapper div narrows it to just the face. */
  coverThumbUrl(person: ApiPerson): string | null {
    if (!person.coverAssetId) return null;
    return this.thumbBlobs().get(person.coverAssetId) ?? null;
  }

  /** Face-thumb `blob:` URL for the detail panel, or empty string while
   * the fetch is in flight (the bbox-cropped div just shows its bg
   * placeholder until the blob arrives). */
  faceThumbUrl(assetId: string): string {
    return this.thumbBlobs().get(assetId) ?? '';
  }

  /** Inline-styled bbox crop. The asset thumb is rendered as a
   * background-image; the wrapper div is sized to the bbox aspect ratio
   * and `background-size` / `background-position` are computed so the
   * face fills the wrapper.
   *
   * `bbox` is in normalised `[0,1]` proportions of the source image —
   * the face detector emits them this way (see
   * `api/enrichment/face-detector.ts`) and they survive end-to-end
   * unchanged. Percent-based CSS positioning consumes proportions
   * directly without needing to know the thumb's intrinsic pixel size.
   *
   * NOTE: this assumes the bbox shares the thumb's aspect ratio (it
   * does — the face detector ran on the same thumbnail). For library
   * photos with weird aspect ratios the crop is approximate but
   * recognisable.
   */
  faceCropStyle(face: {
    assetId: string;
    bbox: Bbox;
  }): Record<string, string> {
    const url = this.faceThumbUrl(face.assetId);
    // Empty URL = blob fetch hasn't resolved yet. Skip background-image
    // entirely rather than emitting `url()`, which renders as a broken
    // image in some browsers.
    if (!url) return {};
    const { x, y, w, h } = face.bbox;
    // Treat the bbox as proportions of the thumb's natural size. The
    // worker emits pixel coords; without knowing the thumb dims we
    // approximate by assuming the dominant face is roughly centred.
    // The CSS scales the image so the bbox fills the wrapper; clamp to
    // 1 to avoid divide-by-zero on bad data.
    const scaleX = Math.max(1, 1 / Math.max(0.01, w));
    const scaleY = Math.max(1, 1 / Math.max(0.01, h));
    const scale = Math.max(scaleX, scaleY);
    const px = -x * scale * 100;
    const py = -y * scale * 100;
    return {
      'background-image': `url(${url})`,
      'background-size': `${scale * 100}% auto`,
      'background-position': `${px}% ${py}%`,
      'background-repeat': 'no-repeat',
    };
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
