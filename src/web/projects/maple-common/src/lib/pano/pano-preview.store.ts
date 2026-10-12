// PanoPreviewStore — the merge dialog's quick panorama preview (#4580).
//
// `request()` debounces, then creates a `pano_preview` job (the server cancels
// any preview it supersedes), polls its progress, and fetches the finished
// PNG. The last finished preview stays on screen while a newer one runs, and
// its job id is the alignment reference both the next preview and the
// "Create panorama" stitch start from, so matching is not repeated.
//
// Provided per dialog instance; `dispose()` cancels the in-flight job and
// releases the image's object URL.

import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { EMPTY, Observable, Subject, defer, of, timer } from 'rxjs';
import { catchError, debounceTime, map, switchMap, takeWhile, tap } from 'rxjs/operators';
import {
  PanoService,
  type PanoJobProgress,
  type PanoJobView,
  type PanoPreviewResult,
  type PanoStitchRequest,
} from '../api/pano.service';

export const PREVIEW_DEBOUNCE_MS = 600;
export const PREVIEW_POLL_MS = 1_000;

export interface PanoPreviewImage {
  jobId: string;
  url: string;
  result: PanoPreviewResult | null;
}

export type PanoPreviewRun =
  | { kind: 'idle' }
  | { kind: 'running'; progress: PanoJobProgress | null }
  | { kind: 'failed'; message: string };

type Step = { run: PanoPreviewRun } | { image: Omit<PanoPreviewImage, 'url'>; blob: Blob };

function failureMessage(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) return 'Preview failed.';
  return err.status === 409 && err.error?.error === 'pano_job_running'
    ? 'A panorama is being stitched; the preview will be available afterwards.'
    : (err.error?.message ?? 'Preview failed.');
}

function jobStep(job: PanoJobView): Step {
  if (job.status === 'failed')
    return { run: { kind: 'failed', message: job.error ?? 'Preview failed.' } };
  if (job.status === 'cancelled') return { run: { kind: 'idle' } };
  return { run: { kind: 'running', progress: job.progress } };
}

@Injectable()
export class PanoPreviewStore implements OnDestroy {
  private readonly pano = inject(PanoService);

  readonly run = signal<PanoPreviewRun>({ kind: 'idle' });
  readonly image = signal<PanoPreviewImage | null>(null);

  private readonly requests = new Subject<PanoStitchRequest | null>();
  private inFlightJobId: string | null = null;

  private readonly subscription = this.requests
    .pipe(
      debounceTime(PREVIEW_DEBOUNCE_MS),
      switchMap((req) => (req === null ? EMPTY : this.preview(req))),
    )
    .subscribe((step) => this.apply(step));

  /** Preview this request once the options stop changing. */
  request(req: PanoStitchRequest): void {
    this.run.set({ kind: 'running', progress: null });
    this.requests.next(req);
  }

  /** Stop the in-flight preview (server job included); a finished one stays. */
  cancel(): void {
    this.requests.next(null);
    if (this.inFlightJobId !== null) this.pano.cancelJob(this.inFlightJobId).subscribe();
    this.inFlightJobId = null;
    this.run.set({ kind: 'idle' });
  }

  /** The finished preview whose alignment a stitch can start from. */
  alignmentFrom(): string | null {
    return this.image()?.jobId ?? null;
  }

  dispose(): void {
    this.cancel();
    this.replaceImage(null);
  }

  ngOnDestroy(): void {
    this.dispose();
    this.subscription.unsubscribe();
  }

  private preview(req: PanoStitchRequest): Observable<Step> {
    const alignmentFrom = this.alignmentFrom();
    return this.pano.preview({ ...req, ...(alignmentFrom ? { alignmentFrom } : {}) }).pipe(
      tap(({ id }) => (this.inFlightJobId = id)),
      switchMap(({ id }) => this.poll(id)),
      catchError((err: unknown) => {
        this.inFlightJobId = null;
        return of<Step>({ run: { kind: 'failed', message: failureMessage(err) } });
      }),
    );
  }

  private poll(jobId: string): Observable<Step> {
    return timer(0, PREVIEW_POLL_MS).pipe(
      switchMap(() => this.pano.getJob(jobId)),
      takeWhile((job) => job.status === 'queued' || job.status === 'running', true),
      switchMap((job) => (job.status === 'done' ? this.fetchImage(job) : of(jobStep(job)))),
    );
  }

  private fetchImage(job: PanoJobView): Observable<Step> {
    return defer(() => {
      this.inFlightJobId = null;
      return this.pano.previewImage(job.id);
    }).pipe(
      map((blob) => ({
        image: { jobId: job.id, result: job.result as PanoPreviewResult | null },
        blob,
      })),
    );
  }

  private apply(step: Step): void {
    if ('run' in step) {
      this.run.set(step.run);
      return;
    }
    this.replaceImage({ ...step.image, url: URL.createObjectURL(step.blob) });
    this.run.set({ kind: 'idle' });
  }

  private replaceImage(next: PanoPreviewImage | null): void {
    const previous = this.image();
    if (previous) URL.revokeObjectURL(previous.url);
    this.image.set(next);
  }
}
