// BatchRenameDialogComponent — the "Batch Rename…" modal (#2640): a
// template-token editor with a live before→after preview list, applied
// sequentially through the server's batch-rename endpoints (#2636). See
// `docs/superpowers/specs/2026-08-04-file-management-design.md` § "Rename"
// for the batch semantics (sequential application, self-collision mid-batch)
// and `batch-rename.service.ts`'s doc for the address→Mongo-id bridge.
//
// One instance handles ONE dialog open→close cycle — mirrors
// `FolderTreeCrudComponent`'s "mount fresh" convention: the host destroys
// this component (nulling whatever signal gates it) once `dismiss` fires,
// so a fresh instance with fresh state handles the next open.
//
// Three phases, held in `phase`:
//   'edit'     — template form + live preview list, debounced on every
//                template/sequence-start/pad-width change.
//   'applying' — Apply request in flight; the form is locked.
//   'done'     — apply's per-file results + partial-failure summary. The
//                only way out of this phase is Close (there's no "undo",
//                matching the design doc's "successes are not rolled back").

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, Subscription, catchError, debounceTime, of, switchMap } from 'rxjs';
import { errorMessage } from '../util/errors';
import {
  BatchRenameFormComponent,
  type BatchRenameCollisionOption,
} from './batch-rename-form.component';
import { BatchRenameResultsComponent } from './batch-rename-results.component';
import { BatchRenameService } from './batch-rename.service';
import {
  BATCH_RENAME_TOKEN_HELP,
  DEFAULT_BATCH_RENAME_TEMPLATE,
  type BatchRenameApplyResult,
  type BatchRenameCollisionPolicy,
  type BatchRenamePreviewItem,
  type BatchRenameSelection,
  type BatchRenameTemplateOptions,
  type ResolvedBatchRenameId,
} from './batch-rename.types';

type Phase = 'edit' | 'applying' | 'done';

const COLLISION_OPTIONS: ReadonlyArray<BatchRenameCollisionOption> = [
  { value: 'auto-suffix', label: 'Auto-suffix (add a number)' },
  { value: 'skip', label: 'Skip' },
  { value: 'replace', label: 'Replace' },
  { value: 'keep-both', label: 'Keep both' },
];

const MAX_TEMPLATE_LENGTH = 512;
const PREVIEW_DEBOUNCE_MS = 250;

@Component({
  selector: 'app-batch-rename-dialog',
  standalone: true,
  imports: [BatchRenameFormComponent, BatchRenameResultsComponent],
  templateUrl: './batch-rename-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BatchRenameDialogComponent implements OnInit {
  private readonly service = inject(BatchRenameService);

  readonly selections = input.required<BatchRenameSelection[]>();

  readonly dismiss = output<void>();
  /** Emits once, after a successful apply, so the host can refresh its
   * grid/tree state. Carries nothing beyond "something changed" — the
   * per-file detail already rendered in the 'done' phase is this
   * component's business, not the host's. */
  readonly applied = output<void>();

  readonly tokenHelp = BATCH_RENAME_TOKEN_HELP;
  readonly collisionOptions = COLLISION_OPTIONS;
  readonly maxTemplateLength = MAX_TEMPLATE_LENGTH;

  readonly phase = signal<Phase>('edit');

  readonly template = signal(DEFAULT_BATCH_RENAME_TEMPLATE);
  readonly sequenceStart = signal(1);
  readonly sequencePadWidth = signal(0);
  readonly collision = signal<BatchRenameCollisionPolicy>('auto-suffix');

  readonly resolving = signal(true);
  readonly resolvedIds = signal<ResolvedBatchRenameId[]>([]);
  private readonly unresolvedCount = computed(
    () => this.resolvedIds().filter((row) => row.id === null).length,
  );

  readonly previewLoading = signal(false);
  readonly previewItems = signal<BatchRenamePreviewItem[]>([]);
  readonly previewError = signal<string | null>(null);

  readonly applyBusy = signal(false);
  readonly applyError = signal<string | null>(null);
  readonly applyResult = signal<BatchRenameApplyResult | null>(null);

  /** True once at least one preview row would actually change something —
   * an empty selection, or a template that renders every row's current
   * name unchanged, isn't worth an Apply round-trip. Errors don't block
   * Apply on their own: a partial batch (some resolvable, some not) should
   * still let the resolvable rows through, matching the endpoint's own
   * partial-failure contract. */
  readonly canApply = computed(() => {
    if (this.resolving() || this.previewLoading() || this.applyBusy()) return false;
    const template = this.template().trim();
    if (template.length === 0 || template.length > MAX_TEMPLATE_LENGTH) return false;
    return this.previewItems().some((item) => item.newFilename !== null);
  });

  readonly duplicateCount = computed(
    () => this.previewItems().filter((item) => item.duplicate).length,
  );

  private readonly refresh$ = new Subject<void>();
  private applySubscription: Subscription | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.applySubscription?.unsubscribe());

    this.refresh$
      .pipe(
        debounceTime(PREVIEW_DEBOUNCE_MS),
        switchMap(() => {
          this.previewLoading.set(true);
          this.previewError.set(null);
          const options = this.currentOptions();
          return this.service.preview(this.resolvedIds(), options).pipe(
            catchError((err) => {
              this.previewError.set(errorMessage(err));
              return of(null);
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((items) => {
        this.previewLoading.set(false);
        if (items) this.previewItems.set(items);
      });
  }

  ngOnInit(): void {
    // Signal inputs aren't guaranteed settled inside the constructor body
    // (same caveat as `FolderRenameDialogComponent`'s `linkedSignal` doc) —
    // `ngOnInit` is the first point `selections()` is safe to read.
    this.service.resolveIds(this.selections()).subscribe((resolved) => {
      this.resolvedIds.set(resolved);
      this.resolving.set(false);
      this.refresh$.next();
    });
  }

  private currentOptions(): BatchRenameTemplateOptions {
    return {
      template: this.template(),
      sequenceStart: this.sequenceStart(),
      sequencePadWidth: this.sequencePadWidth(),
    };
  }

  onTemplateInput(value: string): void {
    this.template.set(value.slice(0, MAX_TEMPLATE_LENGTH));
    this.refresh$.next();
  }

  onSequenceStartInput(value: string): void {
    const parsed = Number.parseInt(value, 10);
    this.sequenceStart.set(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
    this.refresh$.next();
  }

  onSequencePadWidthInput(value: string): void {
    const parsed = Number.parseInt(value, 10);
    this.sequencePadWidth.set(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
    this.refresh$.next();
  }

  onCollisionChange(value: string): void {
    this.collision.set(value as BatchRenameCollisionPolicy);
  }

  /** Appends a token to the end of the template — a simple, predictable
   * insertion point rather than cursor-tracking, since the field is a
   * plain text input the user can still edit freely afterward. */
  insertToken(token: string): void {
    if (this.applyBusy()) return;
    this.onTemplateInput(this.template() + token);
  }

  onApply(): void {
    if (!this.canApply()) return;
    this.phase.set('applying');
    this.applyBusy.set(true);
    this.applyError.set(null);
    this.applySubscription?.unsubscribe();
    this.applySubscription = this.service
      .apply(this.resolvedIds(), this.currentOptions(), this.collision())
      .subscribe({
        next: (result) => {
          this.applyBusy.set(false);
          this.applyResult.set(result);
          this.phase.set('done');
          this.applied.emit();
        },
        error: (err) => {
          this.applyBusy.set(false);
          this.applyError.set(errorMessage(err));
          this.phase.set('edit');
        },
      });
  }

  onCancel(): void {
    if (this.applyBusy()) return;
    this.dismiss.emit();
  }

  onClose(): void {
    this.dismiss.emit();
  }

  onBackdropClick(): void {
    if (this.phase() === 'done') {
      this.onClose();
      return;
    }
    this.onCancel();
  }

  hasUnresolved(): boolean {
    return this.unresolvedCount() > 0;
  }

  unresolvedMessage(): string {
    const n = this.unresolvedCount();
    return `${n} of ${this.resolvedIds().length} selected file${n === 1 ? '' : 's'} could not be looked up and will be skipped.`;
  }

  /** "18 of 20 renamed, 2 skipped: collision" — the design doc's exact
   * example shape. Skip reasons are folded into one clause only when every
   * skip shares the same reason; a mixed batch just says "N skipped". */
  summaryMessage(result: BatchRenameApplyResult): string {
    const { total, relocated, skipped, failed } = result.summary;
    const parts = [`${relocated} of ${total} renamed`];
    if (skipped > 0) {
      const reasons = new Set(
        result.results
          .filter((r): r is Extract<typeof r, { kind: 'skipped' }> => r.kind === 'skipped')
          .map((r) => r.reason),
      );
      const uniform = reasons.size === 1 ? [...reasons][0] : null;
      parts.push(uniform ? `${skipped} skipped: ${uniform}` : `${skipped} skipped`);
    }
    if (failed > 0) parts.push(`${failed} failed`);
    return parts.join(', ');
  }
}
