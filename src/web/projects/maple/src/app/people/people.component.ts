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
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { NgStyle } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  ApiPerson,
  ApiPersonDetail,
  API_BASE_URL,
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
export class PeopleComponent implements OnInit {
  private readonly api = inject(BunApiBackendService);
  private readonly base = inject(API_BASE_URL);
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

  /** URL for the cover thumbnail. Falls back to a placeholder asset id
   * derived from the cover face id (which is itself optional). */
  coverThumbUrl(person: ApiPerson): string | null {
    if (!person.coverFaceId) return null;
    return `${this.base}/assets/${person.coverFaceId}/thumb`;
  }

  /** URL for a face thumbnail in the detail panel. The bbox crop happens
   * client-side via CSS background-position — this URL is the same per-
   * asset thumb the grid uses. */
  faceThumbUrl(assetId: string): string {
    return `${this.base}/assets/${assetId}/thumb`;
  }

  /** Inline-styled bbox crop. The asset thumb is rendered as a
   * background-image; the wrapper div is sized to the bbox aspect ratio
   * and `background-size` / `background-position` are computed so the
   * face fills the wrapper.
   *
   * The bbox is in thumb-source pixel coords; we don't know the thumb's
   * actual rendered size at the worker level, so we use percent-based
   * background-position which is independent of the thumb's intrinsic
   * dimensions.
   *
   * NOTE: this assumes the face detector outputs bboxes that are
   * normalised to the same aspect ratio as the thumb (which it is —
   * see face-worker.ts). For library photos with weird aspect ratios
   * the crop is approximate but recognisable.
   */
  faceCropStyle(face: {
    assetId: string;
    bbox: { x: number; y: number; w: number; h: number };
  }): Record<string, string> {
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
      'background-image': `url(${this.faceThumbUrl(face.assetId)})`,
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
