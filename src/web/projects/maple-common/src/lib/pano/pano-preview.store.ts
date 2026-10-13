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
import { AsyncSubject, EMPTY, Observable, Subject, defer, of, timer } from 'rxjs';
import { catchError, debounceTime, map, switchMap, takeUntil, takeWhile } from 'rxjs/operators';
import {
  PanoService,
  type PanoJobProgress,
  type PanoJobView,
  type PanoPreviewResult,
  type PanoStitchRequest,
} from '../api/pano.service';

export const PREVIEW_DEBOUNCE_MS = 600;
export const PREVIEW_POLL_MS = 1_000;

interface PanoPreviewImage {
  jobId: string;
  url: string;
  result: PanoPreviewResult | null;
}

type PanoPreviewRun =
  | { kind: 'idle' }
  | { kind: 'running'; progress: PanoJobProgress | null }
  | { kind: 'failed'; message: string };

interface PreviewTicket {
  req: PanoStitchRequest;
  generation: number;
}

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

  private readonly requests = new Subject<PreviewTicket>();
  private readonly cancels = new Subject<void>();
  private generation = 0;
  private inFlightJobId: string | null = null;
  private inFlightPost$: Observable<void> | null = null;

  private readonly subscription = this.requests
    .pipe(
      debounceTime(PREVIEW_DEBOUNCE_MS),
      switchMap((ticket) => (ticket.generation === this.generation ? this.preview(ticket) : EMPTY)),
    )
    .subscribe((step) => this.apply(step));

  /** Preview this request once the options stop changing. */
  request(req: PanoStitchRequest): void {
    this.run.set({ kind: 'running', progress: null });
    this.generation += 1;
    this.requests.next({ req, generation: this.generation });
  }

  /** Stop the in-flight preview (server job included); a finished one stays. */
  cancel(): void {
    this.generation += 1;
    this.cancels.next();
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

  private preview({ req, generation }: PreviewTicket): Observable<Step> {
    const waitForInFlight = this.inFlightPost$ ?? of(undefined);
    return waitForInFlight.pipe(
      takeUntil(this.cancels),
      switchMap(() => {
        if (generation !== this.generation) return EMPTY;
        return this.startPreview(req, generation);
      }),
    );
  }

  private startPreview(req: PanoStitchRequest, generation: number): Observable<Step> {
    const alignmentFrom = this.alignmentFrom();
    const created = new Observable<string>((subscriber) => {
      const postDone = new AsyncSubject<void>();
      this.inFlightPost$ = postDone.asObservable();

      // Deliberately not torn down with this stream: a job id that arrives
      // after its request was cancelled or superseded is cancelled
      // server-side by `adopt`, instead of being lost with an aborted POST.
      this.pano.preview({ ...req, ...(alignmentFrom ? { alignmentFrom } : {}) }).subscribe({
        next: ({ id }) => {
          this.inFlightPost$ = null;
          postDone.next();
          postDone.complete();
          const adopted = this.adopt(id, generation);
          if (adopted !== null) subscriber.next(adopted);
          subscriber.complete();
        },
        error: (err: unknown) => {
          this.inFlightPost$ = null;
          postDone.next();
          postDone.complete();
          if (generation === this.generation) subscriber.error(err);
          else subscriber.complete();
        },
      });
    });
    return created.pipe(
      switchMap((id) => this.poll(id).pipe(takeUntil(this.cancels))),
      catchError((err: unknown) => {
        this.inFlightJobId = null;
        return of<Step>({ run: { kind: 'failed', message: failureMessage(err) } });
      }),
    );
  }

  private adopt(jobId: string, generation: number): string | null {
    if (generation !== this.generation) {
      this.pano.cancelJob(jobId).subscribe();
      return null;
    }
    this.inFlightJobId = jobId;
    return jobId;
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
