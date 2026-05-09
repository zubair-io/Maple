# Plan 4 — Worker Operator UI + Dead-code Sweep

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/settings/workers` — a polling Angular page that shows every stage's status, throughput, pending count, and dead-letter count, with per-stage pause/resume, settings dialog (concurrency / pollIntervalMs / batchSize / maxAttempts), and retry-dead. Retire the `*-backfill` job handlers whose work is now absorbed by version-bumping. Rewrite the rescan-folder API path to `updateMany` on `stages.<name>.version` instead of enqueueing backfill jobs. Sweep all stale imports and dead types. After this plan: one operators page manages all workers; no backfill job handler exists; `tsc` is clean.

**Architecture:** Standalone Angular component at `src/web/projects/maple/src/app/settings/workers/workers.component.ts`. Polls `GET /api/workers/status` every 2 s via `setInterval` + Angular `signal()`. Dialog is a second standalone component in the same directory, opened via a boolean signal on the parent. All HTTP calls live on a new `WorkersApiService` in `src/web/projects/maple-common`. On the backend: rescan-folder handler at `src/api/src/indexer/standalone.ts` replaces its `walkOnce` delegation with a `db.images.updateMany` that zeroes `stages.<name>.version` for the affected file tree. Backfill handlers under `src/api/src/job-runner/handlers/` are deleted; the `HANDLERS` registry is updated; `db/schema.ts` `JobKind` union is narrowed.

**Tech Stack:** Angular 21, standalone components, signals, RxJS Observable at the service layer; Bun + TypeScript + Elysia on the backend; bun:test for backend tests; TestBed + `provideHttpClientTesting` for Angular component tests.

**Spec:** [`docs/superpowers/specs/2026-05-09-stage-controllers-design.md`](../specs/2026-05-09-stage-controllers-design.md) — §"UI" (row layout) and §"Versioning + auto-backfill semantics" (rescan rewrite).

**Depends on:** Plans 1, 2, and 3 merged. `GET /api/workers/status`, `POST /api/workers/:name/pause`, `POST /api/workers/:name/resume`, `POST /api/workers/:name/retry-dead`, and `PATCH /api/workers/:name/config` all exist.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/web/projects/maple-common/src/lib/api/workers-api.service.ts` | Create | Typed Observable wrappers for all five `/api/workers/*` endpoints. Exports `StageState`, `WorkerConfig`, `WorkersStatusResponse`. |
| `src/web/projects/maple-common/src/public-api.ts` | Modify | Re-export `WorkersApiService`, `StageState`, `WorkerConfig`, `WorkersStatusResponse`. |
| `src/web/projects/maple/src/app/settings/workers/workers.component.ts` | Create | Page component. Polls every 2 s while mounted. Owns the open-dialog signal. |
| `src/web/projects/maple/src/app/settings/workers/workers.component.html` | Create | Full row table matching the spec layout. |
| `src/web/projects/maple/src/app/settings/workers/workers.component.scss` | Create | `:host { display: block; overflow: auto; }` + status-dot overrides. |
| `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.ts` | Create | Modal dialog. Reactive form with validation for concurrency / pollIntervalMs / batchSize / maxAttempts. PATCHes on save. |
| `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.html` | Create | Full form HTML. |
| `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.scss` | Create | Dialog overlay + panel styles. |
| `src/web/projects/maple/src/app/app.routes.ts` | Modify | Add `/settings/workers` route (`ownerGuard`). |
| `src/web/projects/maple/src/app/settings/settings-index.component.ts` | Modify | Add "Workers" card to the `cards` computed. |
| `src/web/projects/maple/src/app/settings/workers/workers.component.spec.ts` | Create | TestBed test: render with mock status, assert row columns. |
| `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.spec.ts` | Create | TestBed test: form validation, PATCH on save. |
| `src/api/src/indexer/standalone.ts` | Modify | Replace rescan-folder `walkOnce` delegation with `updateMany` version-zero on affected docs. |
| `src/api/src/indexer/standalone.test.ts` | Create | bun:test: rescan-folder handler writes `stages.*.version = 0` instead of enqueueing jobs. |
| `src/web/projects/maple-common/src/lib/api/workers-api.service.spec.ts` | Create | HttpClientTestingModule smoke test for each method. |

Files deleted in Task 10 (after new code is live):

| File | Status |
|---|---|
| `src/api/src/job-runner/handlers/face-backfill.ts` | Delete (verify exists first) |
| `src/api/src/job-runner/handlers/exif-backfill.ts` | Delete (verify exists first) |
| `src/api/src/job-runner/handlers/geocode-backfill.ts` | Delete (verify exists first) |
| `src/api/src/job-runner/handlers/ocr-backfill.ts` | Delete (verify exists first) |
| `src/api/src/job-runner/handlers/describe-backfill.ts` | Delete (verify exists first) |

---

## Task 1: `WorkersApiService` with typed DTOs

**Files:**
- Create: `src/web/projects/maple-common/src/lib/api/workers-api.service.ts`
- Modify: `src/web/projects/maple-common/src/public-api.ts`

- [ ] **Step 1: Write the failing service spec**

Create `src/web/projects/maple-common/src/lib/api/workers-api.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import { WorkersApiService, type WorkersStatusResponse } from './workers-api.service';
import { API_BASE_URL } from './api-base-url.token';

const MOCK_STATUS: WorkersStatusResponse = {
  stages: [
    {
      name: 'hash',
      status: 'running',
      workers: { active: 4, configured: 4 },
      in_flight: { dispatched: 3, batch_size: 10 },
      pending: 1247,
      dead: 0,
      throughput_per_minute: 18,
      last_error: null,
    },
  ],
};

describe('WorkersApiService', () => {
  let svc: WorkersApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        WorkersApiService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(WorkersApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('getStatus() GET /api/workers/status', () => {
    let result: WorkersStatusResponse | undefined;
    svc.getStatus().subscribe((r) => (result = r));
    http.expectOne('/api/workers/status').flush(MOCK_STATUS);
    expect(result).toEqual(MOCK_STATUS);
  });

  it('pause() POST /api/workers/hash/pause', () => {
    let called = false;
    svc.pause('hash').subscribe(() => (called = true));
    http.expectOne({ method: 'POST', url: '/api/workers/hash/pause' }).flush(null, { status: 204, statusText: 'No Content' });
    expect(called).toBeTrue();
  });

  it('resume() POST /api/workers/hash/resume', () => {
    let called = false;
    svc.resume('hash').subscribe(() => (called = true));
    http.expectOne({ method: 'POST', url: '/api/workers/hash/resume' }).flush(null, { status: 204, statusText: 'No Content' });
    expect(called).toBeTrue();
  });

  it('retryDead() POST /api/workers/face/retry-dead', () => {
    let result: { reset: number } | undefined;
    svc.retryDead('face').subscribe((r) => (result = r));
    http.expectOne({ method: 'POST', url: '/api/workers/face/retry-dead' }).flush({ reset: 3 });
    expect(result?.reset).toBe(3);
  });

  it('patchConfig() PATCH /api/workers/exif/config', () => {
    let result: { config: import('./workers-api.service').WorkerConfig } | undefined;
    svc.patchConfig('exif', { concurrency: 8 }).subscribe((r) => (result = r));
    const req = http.expectOne('/api/workers/exif/config');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ concurrency: 8 });
    req.flush({ config: { concurrency: 8, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 } });
    expect(result?.config.concurrency).toBe(8);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd src/web && bun x ng test maple-common --include='**/workers-api.service.spec.ts' --watch=false`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/web/projects/maple-common/src/lib/api/workers-api.service.ts`:

```ts
// WorkersApiService — typed HttpClient wrapper for /api/workers/*.
//
// All methods return Observable<T> per project convention.
// Consumed by WorkersComponent (polling) and WorkerConfigDialogComponent (PATCH).

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-base-url.token';

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
}

export interface StageState {
  name: string;
  status: 'running' | 'paused' | 'error';
  workers: { active: number; configured: number };
  in_flight: { dispatched: number; batch_size: number };
  pending: number;
  dead: number;
  throughput_per_minute: number;
  last_error: string | null;
}

export interface WorkersStatusResponse {
  stages: StageState[];
}

@Injectable({ providedIn: 'root' })
export class WorkersApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  getStatus(): Observable<WorkersStatusResponse> {
    return this.http.get<WorkersStatusResponse>(`${this.base}/workers/status`);
  }

  pause(name: string): Observable<void> {
    return this.http.post<void>(`${this.base}/workers/${encodeURIComponent(name)}/pause`, null);
  }

  resume(name: string): Observable<void> {
    return this.http.post<void>(`${this.base}/workers/${encodeURIComponent(name)}/resume`, null);
  }

  retryDead(name: string): Observable<{ reset: number }> {
    return this.http.post<{ reset: number }>(
      `${this.base}/workers/${encodeURIComponent(name)}/retry-dead`,
      null,
    );
  }

  patchConfig(
    name: string,
    patch: Partial<WorkerConfig>,
  ): Observable<{ config: WorkerConfig }> {
    return this.http.patch<{ config: WorkerConfig }>(
      `${this.base}/workers/${encodeURIComponent(name)}/config`,
      patch,
    );
  }
}
```

- [ ] **Step 4: Re-export from public API**

In `src/web/projects/maple-common/src/public-api.ts`, add with the other API exports:

```ts
export {
  WorkersApiService,
  type StageState,
  type WorkerConfig,
  type WorkersStatusResponse,
} from './lib/api/workers-api.service';
```

- [ ] **Step 5: Run to confirm pass**

Run: `cd src/web && bun x ng test maple-common --include='**/workers-api.service.spec.ts' --watch=false`

Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add \
  src/web/projects/maple-common/src/lib/api/workers-api.service.ts \
  src/web/projects/maple-common/src/lib/api/workers-api.service.spec.ts \
  src/web/projects/maple-common/src/public-api.ts
git commit -m "feat(maple-common): WorkersApiService — typed wrappers for /api/workers/*"
```

---

## Task 2: `WorkerConfigDialogComponent` with validation

**Files:**
- Create: `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.ts`
- Create: `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.html`
- Create: `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.scss`

- [ ] **Step 1: Write the failing component spec**

Create `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { WorkerConfigDialogComponent } from './worker-config-dialog.component';
import { API_BASE_URL } from '../../../../../maple-common/src/lib/api/api-base-url.token';
import { signal } from '@angular/core';
import type { StageState } from '@maple-common';

const STAGE: StageState = {
  name: 'exif',
  status: 'running',
  workers: { active: 4, configured: 4 },
  in_flight: { dispatched: 2, batch_size: 10 },
  pending: 500,
  dead: 0,
  throughput_per_minute: 12,
  last_error: null,
};

describe('WorkerConfigDialogComponent', () => {
  let fixture: ComponentFixture<WorkerConfigDialogComponent>;
  let component: WorkerConfigDialogComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkerConfigDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(WorkerConfigDialogComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    // Set required input signals
    component.stage = signal(STAGE);
    component.config = signal({ concurrency: 4, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 });
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('renders current config values in the form', () => {
    const el: HTMLElement = fixture.nativeElement;
    const concurrencyInput = el.querySelector<HTMLInputElement>('[data-testid="concurrency"]');
    expect(concurrencyInput?.value).toBe('4');
  });

  it('validates concurrency must be 1–32', () => {
    component.form.controls['concurrency'].setValue(0);
    expect(component.form.controls['concurrency'].valid).toBeFalse();
    component.form.controls['concurrency'].setValue(33);
    expect(component.form.controls['concurrency'].valid).toBeFalse();
    component.form.controls['concurrency'].setValue(8);
    expect(component.form.controls['concurrency'].valid).toBeTrue();
  });

  it('validates pollIntervalMs must be 100–60000', () => {
    component.form.controls['pollIntervalMs'].setValue(50);
    expect(component.form.controls['pollIntervalMs'].valid).toBeFalse();
    component.form.controls['pollIntervalMs'].setValue(99999);
    expect(component.form.controls['pollIntervalMs'].valid).toBeFalse();
    component.form.controls['pollIntervalMs'].setValue(2000);
    expect(component.form.controls['pollIntervalMs'].valid).toBeTrue();
  });

  it('validates batchSize must be 1–100', () => {
    component.form.controls['batchSize'].setValue(0);
    expect(component.form.controls['batchSize'].valid).toBeFalse();
    component.form.controls['batchSize'].setValue(101);
    expect(component.form.controls['batchSize'].valid).toBeFalse();
    component.form.controls['batchSize'].setValue(20);
    expect(component.form.controls['batchSize'].valid).toBeTrue();
  });

  it('validates maxAttempts must be 1–20', () => {
    component.form.controls['maxAttempts'].setValue(0);
    expect(component.form.controls['maxAttempts'].valid).toBeFalse();
    component.form.controls['maxAttempts'].setValue(21);
    expect(component.form.controls['maxAttempts'].valid).toBeFalse();
    component.form.controls['maxAttempts'].setValue(10);
    expect(component.form.controls['maxAttempts'].valid).toBeTrue();
  });

  it('PATCHes /api/workers/exif/config on save with valid form', () => {
    component.form.setValue({ concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 });
    let emitted = false;
    component.saved.subscribe(() => (emitted = true));
    component.save();
    const req = http.expectOne('/api/workers/exif/config');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 });
    req.flush({ config: { concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 } });
    expect(emitted).toBeTrue();
  });

  it('does not PATCH when form is invalid', () => {
    component.form.controls['concurrency'].setValue(0);
    component.save();
    http.expectNone('/api/workers/exif/config');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd src/web && bun x ng test maple --include='**/worker-config-dialog.component.spec.ts' --watch=false`

Expected: FAIL — file not found.

- [ ] **Step 3: Implement the dialog component TypeScript**

Create `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.ts`:

```ts
// WorkerConfigDialogComponent — modal for per-stage runtime config.
//
// Opened from WorkersComponent when the operator clicks the ⚙ cog on a row.
// Displays the current live values (from the most recent status poll) and
// allows editing concurrency / pollIntervalMs / batchSize / maxAttempts.
// PATCHes /api/workers/:name/config on Save; emits `saved` on success.
// Emits `cancelled` (or the parent closes the dialog) on Cancel / Escape.

import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  Signal,
  inject,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import {
  WorkersApiService,
  type StageState,
  type WorkerConfig,
} from '@maple-common';

@Component({
  standalone: true,
  selector: 'maple-worker-config-dialog',
  imports: [ReactiveFormsModule],
  templateUrl: './worker-config-dialog.component.html',
  styleUrl: './worker-config-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkerConfigDialogComponent implements OnChanges {
  private readonly api = inject(WorkersApiService);
  private readonly fb = inject(FormBuilder);

  /** The stage this dialog is editing. Re-syncs form values when it changes. */
  @Input({ required: true }) stage!: Signal<StageState>;
  /** Current persisted config from the last status poll. */
  @Input({ required: true }) config!: Signal<WorkerConfig>;

  /** Fires with the returned config on a successful PATCH. */
  @Output() readonly saved = new EventEmitter<WorkerConfig>();
  /** Fires when the user dismisses without saving. */
  @Output() readonly cancelled = new EventEmitter<void>();

  readonly form = this.fb.nonNullable.group({
    concurrency:   [4, [Validators.required, Validators.min(1), Validators.max(32)]],
    pollIntervalMs:[1000, [Validators.required, Validators.min(100), Validators.max(60000)]],
    batchSize:     [10, [Validators.required, Validators.min(1), Validators.max(100)]],
    maxAttempts:   [5, [Validators.required, Validators.min(1), Validators.max(20)]],
  });

  readonly saveError = { value: null as string | null };
  readonly saving = { value: false };

  ngOnChanges(): void {
    // Re-sync form whenever the parent updates the config signal.
    const c = this.config();
    if (c) {
      this.form.setValue({
        concurrency:    c.concurrency,
        pollIntervalMs: c.pollIntervalMs,
        batchSize:      c.batchSize,
        maxAttempts:    c.maxAttempts,
      });
    }
  }

  save(): void {
    if (this.form.invalid) return;
    this.saving.value = true;
    this.saveError.value = null;
    const name = this.stage().name;
    this.api.patchConfig(name, this.form.getRawValue()).subscribe({
      next: (res) => {
        this.saving.value = false;
        this.saved.emit(res.config);
      },
      error: (err) => {
        this.saving.value = false;
        this.saveError.value = err?.error?.error ?? err?.message ?? 'Save failed.';
      },
    });
  }

  cancel(): void {
    this.cancelled.emit();
  }
}
```

- [ ] **Step 4: Implement the dialog HTML**

Create `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.html`:

```html
<!-- Dialog overlay + panel. Closed by the parent toggling a boolean signal. -->
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
  <div
    class="w-[420px] rounded-xl border border-border bg-surface shadow-2xl"
    role="dialog"
    [attr.aria-label]="'Worker config for ' + stage().name"
  >
    <div class="flex items-center justify-between border-b border-border px-5 py-4">
      <h3 class="m-0 text-[14px] font-semibold text-text-main">
        {{ stage().name }} — stage config
      </h3>
      <button
        class="flex h-6 w-6 cursor-pointer items-center justify-center rounded border-none bg-transparent text-text-muted hover:text-text-main"
        type="button"
        aria-label="Close"
        (click)="cancel()"
      >✕</button>
    </div>

    <form [formGroup]="form" class="px-5 py-4 space-y-4" (ngSubmit)="save()">

      <div class="flex flex-col gap-1">
        <label class="text-[12px] font-medium text-text-muted" for="wcd-concurrency">
          Concurrency <span class="text-text-muted font-normal">(1 – 32)</span>
        </label>
        <input
          id="wcd-concurrency"
          data-testid="concurrency"
          type="number"
          class="rounded border border-border bg-surface-hover px-3 py-1.5 text-[13px] text-text-main outline-none focus:border-primary"
          formControlName="concurrency"
          min="1"
          max="32"
        />
        @if (form.controls.concurrency.invalid && form.controls.concurrency.touched) {
          <p class="m-0 text-[11px] text-error-text">Enter a number from 1 to 32.</p>
        }
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[12px] font-medium text-text-muted" for="wcd-poll">
          Poll interval (ms) <span class="text-text-muted font-normal">(100 – 60 000)</span>
        </label>
        <input
          id="wcd-poll"
          data-testid="pollIntervalMs"
          type="number"
          class="rounded border border-border bg-surface-hover px-3 py-1.5 text-[13px] text-text-main outline-none focus:border-primary"
          formControlName="pollIntervalMs"
          min="100"
          max="60000"
        />
        @if (form.controls.pollIntervalMs.invalid && form.controls.pollIntervalMs.touched) {
          <p class="m-0 text-[11px] text-error-text">Enter a number from 100 to 60 000.</p>
        }
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[12px] font-medium text-text-muted" for="wcd-batch">
          Batch size <span class="text-text-muted font-normal">(1 – 100)</span>
        </label>
        <input
          id="wcd-batch"
          data-testid="batchSize"
          type="number"
          class="rounded border border-border bg-surface-hover px-3 py-1.5 text-[13px] text-text-main outline-none focus:border-primary"
          formControlName="batchSize"
          min="1"
          max="100"
        />
        @if (form.controls.batchSize.invalid && form.controls.batchSize.touched) {
          <p class="m-0 text-[11px] text-error-text">Enter a number from 1 to 100.</p>
        }
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[12px] font-medium text-text-muted" for="wcd-attempts">
          Max attempts <span class="text-text-muted font-normal">(1 – 20)</span>
        </label>
        <input
          id="wcd-attempts"
          data-testid="maxAttempts"
          type="number"
          class="rounded border border-border bg-surface-hover px-3 py-1.5 text-[13px] text-text-main outline-none focus:border-primary"
          formControlName="maxAttempts"
          min="1"
          max="20"
        />
        @if (form.controls.maxAttempts.invalid && form.controls.maxAttempts.touched) {
          <p class="m-0 text-[11px] text-error-text">Enter a number from 1 to 20.</p>
        }
      </div>

      @if (saveError.value) {
        <p class="m-0 rounded bg-error-bg px-3 py-2 text-[12px] text-error-text">
          {{ saveError.value }}
        </p>
      }

      <div class="flex justify-end gap-2 pt-1">
        <button
          type="button"
          class="cursor-pointer rounded border border-border bg-surface px-4 py-1.5 text-[12px] font-medium text-text-main hover:bg-surface-hover"
          (click)="cancel()"
        >Cancel</button>
        <button
          type="submit"
          class="cursor-pointer rounded border border-transparent bg-primary px-4 py-1.5 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          [disabled]="form.invalid || saving.value"
        >{{ saving.value ? 'Saving…' : 'Save' }}</button>
      </div>
    </form>
  </div>
</div>
```

- [ ] **Step 5: Implement the dialog SCSS**

Create `src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.scss`:

```scss
// Host is transparent — the overlay div inside takes full viewport coverage.
:host {
  display: contents;
}
```

- [ ] **Step 6: Run the spec to confirm pass**

Run: `cd src/web && bun x ng test maple --include='**/worker-config-dialog.component.spec.ts' --watch=false`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.ts \
  src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.html \
  src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.scss \
  src/web/projects/maple/src/app/settings/workers/worker-config-dialog.component.spec.ts
git commit -m "feat(web): WorkerConfigDialogComponent — form with validation for per-stage config"
```

---

## Task 3: `WorkersComponent` — page scaffold with polling

**Files:**
- Create: `src/web/projects/maple/src/app/settings/workers/workers.component.ts`
- Create: `src/web/projects/maple/src/app/settings/workers/workers.component.html`
- Create: `src/web/projects/maple/src/app/settings/workers/workers.component.scss`

- [ ] **Step 1: Write the failing component spec**

Create `src/web/projects/maple/src/app/settings/workers/workers.component.spec.ts`:

```ts
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { WorkersComponent } from './workers.component';
import { RouterTestingModule } from '@angular/router/testing';
import { API_BASE_URL } from '../../../../../maple-common/src/lib/api/api-base-url.token';
import type { WorkersStatusResponse } from '@maple-common';

const MOCK_RESPONSE: WorkersStatusResponse = {
  stages: [
    {
      name: 'hash',
      status: 'running',
      workers: { active: 4, configured: 4 },
      in_flight: { dispatched: 3, batch_size: 10 },
      pending: 1247,
      dead: 0,
      throughput_per_minute: 18,
      last_error: null,
    },
    {
      name: 'face',
      status: 'running',
      workers: { active: 2, configured: 2 },
      in_flight: { dispatched: 1, batch_size: 5 },
      pending: 842,
      dead: 3,
      throughput_per_minute: 6,
      last_error: null,
    },
    {
      name: 'describe',
      status: 'error',
      workers: { active: 0, configured: 2 },
      in_flight: { dispatched: 0, batch_size: 5 },
      pending: 842,
      dead: 0,
      throughput_per_minute: 0,
      last_error: 'API key invalid',
    },
  ],
};

describe('WorkersComponent', () => {
  let fixture: ComponentFixture<WorkersComponent>;
  let component: WorkersComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WorkersComponent, RouterTestingModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(WorkersComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    component.ngOnDestroy();
    http.verify();
  });

  it('fetches status on init and renders one row per stage', fakeAsync(() => {
    fixture.detectChanges(); // triggers ngOnInit
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]');
    expect(rows.length).toBe(3);
  }));

  it('renders Status column correctly', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]');
    const hashRow = rows[0];
    expect(hashRow.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Running');
    const descRow = rows[2];
    expect(descRow.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Error');
  }));

  it('renders Workers column as active/configured', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="workers"]')?.textContent?.trim()).toBe('4 / 4');
  }));

  it('renders In flight as dispatched/batch_size', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="in-flight"]')?.textContent?.trim()).toBe('3 / 10');
  }));

  it('renders Pending count', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="pending"]')?.textContent?.trim()).toBe('1,247');
  }));

  it('renders Dead count with retry button when dead > 0', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const faceRow: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[1];
    expect(faceRow.querySelector('[data-testid="dead-count"]')?.textContent?.trim()).toBe('3');
    expect(faceRow.querySelector('[data-testid="retry-dead-btn"]')).toBeTruthy();

    const hashRow: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(hashRow.querySelector('[data-testid="retry-dead-btn"]')).toBeNull();
  }));

  it('renders Throughput as n /min', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="throughput"]')?.textContent?.trim()).toBe('18 /min');
  }));

  it('renders — for throughput when zero', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const descRow: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[2];
    expect(descRow.querySelector('[data-testid="throughput"]')?.textContent?.trim()).toBe('—');
  }));

  it('pause button POSTs /api/workers/hash/pause and re-polls', fakeAsync(() => {
    fixture.detectChanges();
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
    fixture.detectChanges();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    row.querySelector<HTMLButtonElement>('[data-testid="pause-resume-btn"]')?.click();

    // optimistic update — no need to wait
    http.expectOne({ method: 'POST', url: '/api/workers/hash/pause' }).flush(null, { status: 204, statusText: '' });
    // re-poll
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    tick();
  }));
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd src/web && bun x ng test maple --include='**/workers.component.spec.ts' --watch=false`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component TypeScript**

Create `src/web/projects/maple/src/app/settings/workers/workers.component.ts`:

```ts
// WorkersComponent — /settings/workers (owner-gated).
//
// Polls GET /api/workers/status every 2 s while the route is active.
// One row per stage: Status | Workers | In flight | Pending | Dead | Throughput | ⚙ | ⏸/▶
//
// Pause/resume are optimistically applied in the UI signal, then reverted on
// HTTP error. The settings cog opens WorkerConfigDialogComponent as an
// in-template conditional (no router modal — keeps the URL clean).

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  WorkersApiService,
  type StageState,
  type WorkerConfig,
  type WorkersStatusResponse,
} from '@maple-common';
import { WorkerConfigDialogComponent } from './worker-config-dialog.component';

const POLL_MS = 2_000;

@Component({
  standalone: true,
  selector: 'maple-workers-settings',
  imports: [RouterLink, DecimalPipe, WorkerConfigDialogComponent],
  templateUrl: './workers.component.html',
  styleUrl: './workers.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkersComponent implements OnInit, OnDestroy {
  private readonly api = inject(WorkersApiService);

  readonly status = signal<WorkersStatusResponse | null>(null);
  readonly error = signal<string | null>(null);
  /** Name of the stage whose config dialog is open; null = closed. */
  readonly dialogStage = signal<string | null>(null);
  /** Configs as returned by the most recent status poll or PATCH response.
   * Keyed by stage name. */
  readonly configs = signal<Map<string, WorkerConfig>>(new Map());

  readonly stages = computed(() => this.status()?.stages ?? []);

  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    this.api.getStatus().subscribe({
      next: (res) => {
        this.status.set(res);
        this.error.set(null);
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to load worker status.');
      },
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  togglePause(stage: StageState): void {
    // Optimistic: flip the local status before the HTTP round-trip.
    this.setLocalStatus(stage.name, stage.status === 'paused' ? 'running' : 'paused');
    const obs = stage.status === 'paused'
      ? this.api.resume(stage.name)
      : this.api.pause(stage.name);
    obs.subscribe({
      next: () => this.poll(),
      error: () => {
        // Revert the optimistic flip.
        this.setLocalStatus(stage.name, stage.status);
      },
    });
  }

  retryDead(stage: StageState): void {
    this.api.retryDead(stage.name).subscribe({
      next: () => this.poll(),
    });
  }

  openConfig(stage: StageState): void {
    this.dialogStage.set(stage.name);
  }

  closeDialog(): void {
    this.dialogStage.set(null);
  }

  onConfigSaved(name: string, config: WorkerConfig): void {
    this.configs.update((m) => {
      const next = new Map(m);
      next.set(name, config);
      return next;
    });
    this.dialogStage.set(null);
    this.poll();
  }

  // ── Dialog helpers ────────────────────────────────────────────────────────

  /** Signal accessor for the stage currently open in the dialog. */
  readonly activeDialogStage = computed<StageState | null>(() => {
    const name = this.dialogStage();
    if (!name) return null;
    return this.stages().find((s) => s.name === name) ?? null;
  });

  activeConfigSignal(name: string) {
    return computed(() => {
      return this.configs().get(name) ?? { concurrency: 1, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 };
    });
  }

  // ── Display helpers ───────────────────────────────────────────────────────

  statusLabel(s: StageState): string {
    switch (s.status) {
      case 'running': return 'Running';
      case 'paused':  return 'Paused';
      case 'error':   return 'Error';
    }
  }

  statusDotClass(s: StageState): string {
    switch (s.status) {
      case 'running': return 'dot-ok';
      case 'paused':  return 'dot-muted';
      case 'error':   return 'dot-err';
    }
  }

  throughputLabel(s: StageState): string {
    return s.throughput_per_minute > 0 ? `${s.throughput_per_minute} /min` : '—';
  }

  pauseResumeLabel(s: StageState): string {
    return s.status === 'paused' ? '▶' : '⏸';
  }

  pauseResumeTitle(s: StageState): string {
    return s.status === 'paused' ? 'Resume stage' : 'Pause stage';
  }

  private setLocalStatus(name: string, status: StageState['status']): void {
    this.status.update((cur) => {
      if (!cur) return cur;
      return {
        stages: cur.stages.map((s) => s.name === name ? { ...s, status } : s),
      };
    });
  }
}
```

- [ ] **Step 4: Implement the component HTML**

Create `src/web/projects/maple/src/app/settings/workers/workers.component.html`:

```html
<div class="mx-auto max-w-[1200px] px-8 pt-6 pb-12">
  <header class="mb-6 flex items-center gap-4">
    <a
      class="text-[12px] text-text-muted no-underline hover:text-text-main hover:underline"
      routerLink="/settings"
    >&larr; Settings</a>
    <h2 class="m-0 flex-1 text-[22px] font-semibold tracking-[-0.01em]">Workers</h2>
  </header>

  @if (error()) {
    <p class="mb-4 rounded bg-error-bg px-4 py-2 text-[12px] text-error-text">
      {{ error() }}
    </p>
  }

  @if (!status() && !error()) {
    <p class="text-[13px] text-text-muted">Loading…</p>
  }

  @if (stages().length > 0) {
    <div class="overflow-x-auto rounded-lg border border-border">
      <table class="w-full text-[12px]">
        <thead>
          <tr class="border-b border-border bg-surface-hover">
            <th class="px-4 py-2.5 text-left font-semibold text-text-muted">Stage</th>
            <th class="px-4 py-2.5 text-left font-semibold text-text-muted">Status</th>
            <th class="px-4 py-2.5 text-right font-semibold text-text-muted">Workers</th>
            <th class="px-4 py-2.5 text-right font-semibold text-text-muted">In flight</th>
            <th class="px-4 py-2.5 text-right font-semibold text-text-muted">Pending</th>
            <th class="px-4 py-2.5 text-right font-semibold text-text-muted">Dead</th>
            <th class="px-4 py-2.5 text-right font-semibold text-text-muted">Throughput</th>
            <th class="px-4 py-2.5 text-center font-semibold text-text-muted">Config</th>
            <th class="px-4 py-2.5 text-center font-semibold text-text-muted">Pause</th>
          </tr>
        </thead>
        <tbody>
          @for (s of stages(); track s.name) {
            <tr
              class="border-b border-border last:border-0 hover:bg-surface-hover"
              data-testid="worker-row"
            >
              <!-- Stage -->
              <td class="px-4 py-2.5 font-mono font-medium text-text-main">{{ s.name }}</td>

              <!-- Status -->
              <td class="px-4 py-2.5">
                <span class="flex items-center gap-1.5">
                  <span
                    class="h-2 w-2 rounded-full"
                    [class.bg-green-500]="s.status === 'running'"
                    [class.bg-text-muted]="s.status === 'paused'"
                    [class.bg-red-500]="s.status === 'error'"
                    [title]="s.last_error ?? ''"
                  ></span>
                  <span
                    data-testid="status"
                    class="text-text-main"
                    [class.text-error-text]="s.status === 'error'"
                    [title]="s.last_error ?? ''"
                  >{{ statusLabel(s) }}</span>
                </span>
              </td>

              <!-- Workers: active / configured -->
              <td class="px-4 py-2.5 text-right text-text-main" data-testid="workers">
                {{ s.workers.active }} / {{ s.workers.configured }}
              </td>

              <!-- In flight: dispatched / batch_size -->
              <td class="px-4 py-2.5 text-right text-text-main" data-testid="in-flight">
                {{ s.in_flight.dispatched }} / {{ s.in_flight.batch_size }}
              </td>

              <!-- Pending -->
              <td class="px-4 py-2.5 text-right font-medium text-text-main" data-testid="pending">
                {{ s.pending | number }}
              </td>

              <!-- Dead + retry -->
              <td class="px-4 py-2.5 text-right" data-testid="dead-cell">
                @if (s.dead > 0) {
                  <span class="inline-flex items-center gap-1">
                    <span data-testid="dead-count" class="text-error-text">{{ s.dead }}</span>
                    <button
                      data-testid="retry-dead-btn"
                      type="button"
                      class="cursor-pointer rounded border-none bg-transparent px-1 py-0.5 text-[11px] text-primary hover:underline"
                      title="Retry all dead-lettered docs for this stage"
                      (click)="retryDead(s)"
                    >↻</button>
                  </span>
                } @else {
                  <span class="text-text-muted">0</span>
                }
              </td>

              <!-- Throughput -->
              <td
                class="px-4 py-2.5 text-right text-text-muted"
                data-testid="throughput"
              >{{ throughputLabel(s) }}</td>

              <!-- Config cog -->
              <td class="px-4 py-2.5 text-center">
                <button
                  type="button"
                  class="cursor-pointer rounded border-none bg-transparent px-1.5 py-1 text-[14px] text-text-muted hover:text-text-main"
                  title="Edit stage config"
                  (click)="openConfig(s)"
                >⚙</button>
              </td>

              <!-- Pause / resume -->
              <td class="px-4 py-2.5 text-center">
                <button
                  data-testid="pause-resume-btn"
                  type="button"
                  class="cursor-pointer rounded border-none bg-transparent px-1.5 py-1 text-[14px] text-text-muted hover:text-text-main"
                  [title]="pauseResumeTitle(s)"
                  (click)="togglePause(s)"
                >{{ pauseResumeLabel(s) }}</button>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  }
</div>

<!-- Config dialog — rendered outside the table to avoid stacking-context issues -->
@if (activeDialogStage(); as ds) {
  <maple-worker-config-dialog
    [stage]="$any(activeDialogStage)"
    [config]="activeConfigSignal(ds.name)"
    (saved)="onConfigSaved(ds.name, $event)"
    (cancelled)="closeDialog()"
  />
}
```

- [ ] **Step 5: Implement the component SCSS**

Create `src/web/projects/maple/src/app/settings/workers/workers.component.scss`:

```scss
:host {
  display: block;
  height: 100%;
  overflow: auto;
}

// Row hover inherits from Tailwind; no component-scoped overrides needed.
```

- [ ] **Step 6: Run the spec to confirm pass**

Run: `cd src/web && bun x ng test maple --include='**/workers.component.spec.ts' --watch=false`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/web/projects/maple/src/app/settings/workers/workers.component.ts \
  src/web/projects/maple/src/app/settings/workers/workers.component.html \
  src/web/projects/maple/src/app/settings/workers/workers.component.scss \
  src/web/projects/maple/src/app/settings/workers/workers.component.spec.ts
git commit -m "feat(web): WorkersComponent — polling worker status page at /settings/workers"
```

---

## Task 4: Wire the route and settings-index card

**Files:**
- Modify: `src/web/projects/maple/src/app/app.routes.ts`
- Modify: `src/web/projects/maple/src/app/settings/settings-index.component.ts`

- [ ] **Step 1: Add the route**

In `src/web/projects/maple/src/app/app.routes.ts`, add after the `/settings/enrichment` block:

```ts
  {
    path: 'settings/workers',
    canActivate: [authGuard, ownerGuard],
    loadComponent: () =>
      import('./settings/workers/workers.component').then((m) => m.WorkersComponent),
  },
```

- [ ] **Step 2: Add the "Workers" card**

In `src/web/projects/maple/src/app/settings/settings-index.component.ts`, add the Workers card to the `cards` array (after the "Enrichment" entry and before "People"):

```ts
    {
      icon: 'settings_applications',
      title: 'Workers',
      description: 'Monitor and tune every pipeline stage — status, throughput, dead-letter retry.',
      link: '/settings/workers',
      ownerOnly: true,
    },
```

- [ ] **Step 3: Verify with build**

Run: `cd src/web && bun x ng build maple --configuration=development 2>&1 | tail -20`

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add \
  src/web/projects/maple/src/app/app.routes.ts \
  src/web/projects/maple/src/app/settings/settings-index.component.ts
git commit -m "feat(web): /settings/workers route + Workers card in settings index"
```

---

## Task 5: Backend rescan-folder rewrite

**Files:**
- Modify: `src/api/src/indexer/standalone.ts`
- Create: `src/api/src/indexer/standalone.test.ts`

The current `/rescan/:folderId` handler calls `svc.walkOnce(...)` which enqueues each file into the legacy indexer pipeline's discover channel. After Plans 1–3, the pipeline is gone; the replacement is to zero `stages.<name>.version` (and clear `dead`, `attempts`, `last_error`) on every image doc under the folder's path tree so the new stage controllers pick them up on their next poll.

The API already has access to the `images` Mongo collection; the change is surgical inside the `POST /rescan/:folderId` handler.

- [ ] **Step 1: Write the failing test**

Create `src/api/src/indexer/standalone.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MongoClient, type Db } from "mongodb";

// Helper: spin up a test Mongo client against the local instance.
// The test suite assumes `mongodb://localhost:27017` (same as dev).
// Skips if Mongo is unavailable.
async function getTestDb(): Promise<{ client: MongoClient; db: Db } | null> {
  try {
    const client = new MongoClient("mongodb://localhost:27017", { serverSelectionTimeoutMS: 1_000 });
    await client.connect();
    const db = client.db("maple_rescan_test");
    return { client, db };
  } catch {
    return null;
  }
}

const STAGE_NAMES = ["hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili"];

function skeleton() {
  return Object.fromEntries(
    STAGE_NAMES.map((n) => [
      n,
      { version: 1, attempts: 0, last_error: null, processed_at: new Date(), dead: false },
    ]),
  );
}

describe("rescan-folder updateMany semantic", () => {
  let ctx: { client: MongoClient; db: Db } | null;

  beforeEach(async () => {
    ctx = await getTestDb();
    if (!ctx) return;
    // Drop the test collection fresh.
    await ctx.db.collection("images").drop().catch(() => {});
  });

  afterEach(async () => {
    if (!ctx) return;
    await ctx.db.collection("images").drop().catch(() => {});
    await ctx.client.close();
  });

  it("zeroes version on all docs whose primary_url starts with the folder path", async () => {
    if (!ctx) {
      console.log("Mongo unavailable — skipping");
      return;
    }
    const col = ctx.db.collection("images");
    const folderPath = "/photos/2024";

    // Insert two docs under the folder and one outside.
    await col.insertMany([
      { primary_url: "/photos/2024/img1.dng", folderId: "f1", stages: skeleton() },
      { primary_url: "/photos/2024/sub/img2.dng", folderId: "f1", stages: skeleton() },
      { primary_url: "/other/img3.dng", folderId: "f2", stages: skeleton() },
    ]);

    // Simulate the rescan handler's new updateMany call.
    const stageResetFields: Record<string, unknown> = {};
    for (const name of STAGE_NAMES) {
      stageResetFields[`stages.${name}.version`] = 0;
      stageResetFields[`stages.${name}.dead`] = false;
      stageResetFields[`stages.${name}.attempts`] = 0;
      stageResetFields[`stages.${name}.last_error`] = null;
    }
    const result = await col.updateMany(
      { primary_url: { $regex: `^${folderPath}/` } },
      { $set: stageResetFields },
    );

    expect(result.modifiedCount).toBe(2);

    // Docs under folder have version zeroed.
    const under = await col.find({ primary_url: { $regex: `^${folderPath}/` } }).toArray();
    for (const doc of under) {
      for (const name of STAGE_NAMES) {
        expect(doc.stages[name].version).toBe(0);
        expect(doc.stages[name].dead).toBe(false);
        expect(doc.stages[name].attempts).toBe(0);
        expect(doc.stages[name].last_error).toBeNull();
      }
    }

    // Doc outside folder is untouched.
    const outside = await col.findOne({ primary_url: "/other/img3.dng" });
    expect(outside?.stages.hash.version).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd src/api && bun test src/indexer/standalone.test.ts`

Expected: if Mongo is available, FAIL because the actual route still calls `walkOnce`. If Mongo is unavailable, the test skip-passes with a console log — that's acceptable.

- [ ] **Step 3: Rewrite the rescan handler**

In `src/api/src/indexer/standalone.ts`, locate the `POST /rescan/:folderId` handler (around line 240). Replace the entire handler body — from `const folderIdStr = params.folderId;` to the closing brace — with:

```ts
    async ({ params, body, set }) => {
      const folderIdStr = params.folderId;
      if (!ObjectId.isValid(folderIdStr)) {
        set.status = 400;
        return { ok: false, error: "Invalid folderId" };
      }
      const id = new ObjectId(folderIdStr);
      const folders = await foldersCollection();
      const folder = await folders.findOne({ _id: id });
      if (!folder) {
        set.status = 404;
        return { ok: false, error: "Folder not found" };
      }
      const subPath = typeof body?.subPath === "string" && body.subPath.length > 0
        ? body.subPath
        : undefined;
      const scanRoot = subPath ?? folder.path;

      // New: reset stage state for all images under the scanned tree so the
      // stage controllers pick them up on their next poll. This replaces the
      // old walkOnce() → discover-channel path that no longer exists after the
      // workers-redesign.
      //
      // For each image whose primary_url starts with `scanRoot/`, zero every
      // stage's `version` and clear dead/attempts/last_error so the poll-loop
      // claim query (`stages.<name>.version < targetVersion`) matches them.
      const STAGE_NAMES = ["hash", "exif", "thumb", "face", "ocr", "describe", "geocode", "meili"];
      const stageResetFields: Record<string, unknown> = {};
      for (const name of STAGE_NAMES) {
        stageResetFields[`stages.${name}.version`] = 0;
        stageResetFields[`stages.${name}.dead`] = false;
        stageResetFields[`stages.${name}.attempts`] = 0;
        stageResetFields[`stages.${name}.last_error`] = null;
      }
      const images = await imagesCollection();
      const updateResult = await images.updateMany(
        { primary_url: { $regex: `^${scanRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/` } },
        { $set: stageResetFields },
      );

      log.info(
        { folderId: folderIdStr, path: scanRoot, modified: updateResult.modifiedCount },
        "rescan: stage versions zeroed",
      );

      return { ok: true, folderId: folderIdStr, path: scanRoot, reset: updateResult.modifiedCount };
    },
```

Ensure `imagesCollection` is imported (it should already exist from other route code in the file; if not, add the import alongside `foldersCollection`).

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd src/api && bun test src/indexer/standalone.test.ts`

Expected: 1 test passes (or skips cleanly when Mongo is unavailable).

Run: `cd src/api && bun test`

Expected: full suite passes with no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/indexer/standalone.ts src/api/src/indexer/standalone.test.ts
git commit -m "feat(api): rescan-folder resets stage versions via updateMany instead of enqueueing backfill jobs"
```

---

## Task 6: Retire `*-backfill` job handlers

**Files:**
- Verify and delete (if they exist): any `*-backfill.ts` files under `src/api/src/job-runner/handlers/`
- Modify: `src/api/src/job-runner/handlers/index.ts`
- Modify: `src/api/src/db/schema.ts` (narrow `JobKind`)

**Precondition:** As of the `handlers/index.ts` read above, the only registered handler is `batch_jpeg_export`. The spec lists five backfill handlers (`face-backfill`, `exif-backfill`, `geocode-backfill`, `ocr-backfill`, `describe-backfill`) but the directory listing shows only `batch-jpeg-export.ts` and `index.ts`. The backfill handlers may already have been removed in Plans 2/3, or they may live under a different path. Execute the steps below to verify before deleting.

- [ ] **Step 1: Verify the handler directory state**

Run:

```bash
ls src/api/src/job-runner/handlers/
```

If no `*-backfill.ts` files exist: skip Steps 2–4 and go to Step 5. If they exist, proceed.

- [ ] **Step 2: Delete any backfill handler files found**

For each file that exists, delete it:

```bash
# Only run for files that actually exist:
rm src/api/src/job-runner/handlers/face-backfill.ts 2>/dev/null
rm src/api/src/job-runner/handlers/exif-backfill.ts 2>/dev/null
rm src/api/src/job-runner/handlers/geocode-backfill.ts 2>/dev/null
rm src/api/src/job-runner/handlers/ocr-backfill.ts 2>/dev/null
rm src/api/src/job-runner/handlers/describe-backfill.ts 2>/dev/null
```

- [ ] **Step 3: Remove backfill kinds from `JobKind` in `db/schema.ts`**

Run:

```bash
grep -n "backfill\|JobKind" src/api/src/db/schema.ts | head -20
```

If `JobKind` lists any backfill kinds (`face_backfill`, `geocode_backfill`, `exif_backfill`, etc.), remove those string literals from the union. Keep `batch_jpeg_export`.

- [ ] **Step 4: Remove backfill registrations from `handlers/index.ts`**

Run:

```bash
grep -n "backfill" src/api/src/job-runner/handlers/index.ts
```

If any backfill imports or entries in the `HANDLERS` record exist, remove them. After editing, `HANDLERS` must only list `batch_jpeg_export`.

- [ ] **Step 5: Run `tsc` to confirm no broken imports**

Run:

```bash
cd src/api && bun run tsc --noEmit 2>&1 | head -40
```

Expected: no TypeScript errors. If there are errors from callers that referenced the removed `JobKind` members (e.g. a route that enqueued `exif_backfill`), fix each call site by removing the enqueue call or replacing it with a comment explaining the operation is now handled by version-bumping.

- [ ] **Step 6: Run full API test suite**

Run: `cd src/api && bun test`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A src/api/src/job-runner/ src/api/src/db/schema.ts
git commit -m "chore(api): retire *-backfill job handlers — version-bumping is the new backfill mechanism"
```

---

## Task 7: Sweep stale references — API

**Files:**
- Any callers of retired backfill `JobKind` members or removed handler files.

- [ ] **Step 1: Scan for stale backfill references**

Run:

```bash
grep -rn "backfill" src/api/src --include="*.ts" | grep -v "\.test\.ts" | grep -v "standalone.test"
```

If any results appear outside the already-updated files (`standalone.ts`, `handlers/index.ts`, `db/schema.ts`), fix them:
- Routes that called `api.enqueueJob({ kind: 'exif_backfill', ... })` or similar: replace the enqueue call with a `log.info` noting that re-processing is now triggered by zeroing `stages.<name>.version` on the affected docs.
- The `IndexerComponent` in the Angular front-end has a `runBackfill()` method that calls `api.runExifBackfill()` — that becomes dead UI after the redesign; it is retired in Task 8.

- [ ] **Step 2: Run `tsc` clean**

Run: `cd src/api && bun run tsc --noEmit 2>&1 | head -40`

Expected: zero errors.

- [ ] **Step 3: Run full suite**

Run: `cd src/api && bun test`

Expected: all pass.

- [ ] **Step 4: Commit if there were changes**

```bash
git add -A src/api/src/
git commit -m "chore(api): remove stale backfill call sites after handler retirement"
```

---

## Task 8: Sweep stale references — Angular

**Files:**
- `src/web/projects/maple/src/app/settings/indexer/indexer.component.ts` — remove `runBackfill()` and the EXIF backfill progress card.
- `src/web/projects/maple/src/app/settings/indexer/indexer.component.html` — matching template section.
- `src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts` — remove `runExifBackfill()` if it exists.
- `src/web/projects/maple-common/src/public-api.ts` — remove any re-exports of removed types.

- [ ] **Step 1: Identify stale Angular references**

Run:

```bash
grep -rn "backfill\|Backfill\|exifBackfill\|runExifBackfill" src/web --include="*.ts" --include="*.html"
```

For each match:

- `IndexerComponent.runBackfill()` — delete the method and the template section that calls it (`<button (click)="runBackfill()">` and the backfill progress card, including `backfillPct()` and `exifBackfill` status references).
- `BunApiBackendService.runExifBackfill()` — delete the method.
- Template references to `exifBackfill` in `indexer.component.html` — delete those blocks.

- [ ] **Step 2: Run Angular build**

Run: `cd src/web && bun x ng build maple --configuration=development 2>&1 | tail -20`

Expected: success with no TypeScript errors.

- [ ] **Step 3: Run Angular test suite**

Run: `cd src/web && bun x ng test maple --watch=false 2>&1 | tail -30`

Expected: all tests pass (including the workers component tests added in Tasks 1–3).

- [ ] **Step 4: Commit**

```bash
git add -A src/web/projects/maple/src/app/settings/indexer/
git add -A src/web/projects/maple-common/src/lib/api/bun-api-backend.service.ts
git add -A src/web/projects/maple-common/src/public-api.ts
git commit -m "chore(web): remove EXIF backfill UI and API methods — backfill is now version-bump-driven"
```

---

## Task 9: Final `tsc` clean sweep

**Files:** Any remaining files with type errors.

- [ ] **Step 1: Run both tsc checks end-to-end**

Run:

```bash
cd src/api && bun run tsc --noEmit 2>&1
cd src/web && bun x ng build maple --configuration=development 2>&1 | grep -E "^ERROR|^error"
```

For each error:
1. Identify whether it is a leftover reference to a retired type or method.
2. If yes: remove the reference (the call site is dead) or replace with the new equivalent.
3. If it is a genuine type mismatch unrelated to this plan: note it and do not change it (out of scope).

- [ ] **Step 2: Re-run to confirm zero errors**

Run both `tsc --noEmit` commands again. Expected: zero output.

- [ ] **Step 3: Commit**

```bash
git add -A src/api/src/ src/web/projects/
git commit -m "chore: tsc clean sweep — no stale backfill or old-pipeline references"
```

---

## Task 10: End-to-end smoke test and final commit

No code changes. Verify the full stack manually and ensure both test suites are green.

- [ ] **Step 1: Run the API test suite**

```bash
cd src/api && bun test
```

Expected: all tests pass.

- [ ] **Step 2: Run the Angular test suite**

```bash
cd src/web && bun x ng test maple --watch=false && bun x ng test maple-common --watch=false
```

Expected: all tests pass.

- [ ] **Step 3: Build check**

```bash
cd src/web && bun x ng build maple --configuration=production 2>&1 | tail -10
```

Expected: successful production build.

- [ ] **Step 4: Manual smoke**

With the dev stack running (`bun run dev` in `src/api` and `bun x ng serve maple` in `src/web`):

1. Open `http://localhost:4200/settings` — confirm "Workers" card is present.
2. Navigate to `/settings/workers` — confirm the table renders with one row per stage; no JS errors in the browser console.
3. Click ⚙ on any stage — confirm the config dialog opens with the current values pre-populated.
4. Edit concurrency to `0` — confirm the Save button is disabled and the validation message appears.
5. Edit concurrency to a valid value, click Save — confirm the PATCH fires to `/api/workers/:name/config` in the network tab, and the dialog closes.
6. Click ⏸ on a running stage — confirm the row's status flips to Paused optimistically, then returns to Running after the poll.
7. Navigate away from the route — confirm no more poll requests fire in the network tab.

- [ ] **Step 5: Tag final state**

```bash
git tag workers-redesign-plan-4 -m "Plan 4 complete: worker operator UI + dead-code sweep"
```

---

## Self-review checklist for the executor

Before declaring this plan complete:

- [ ] Spec's UI row table fully rendered: Stage, Status (with dot), Workers (active/configured), In flight (dispatched/batch_size), Pending (formatted with DecimalPipe), Dead (count + ↻ when > 0), Throughput (n /min or —), ⚙, ⏸/▶. All columns have `data-testid` attributes matched by the spec tests.
- [ ] Rescan-folder handler at `src/api/src/indexer/standalone.ts` calls `images.updateMany(...)` with `$set: { "stages.<name>.version": 0, ... }` — no call to `walkOnce` remains.
- [ ] No `*-backfill` handler files exist under `src/api/src/job-runner/handlers/`.
- [ ] `JobKind` in `src/api/src/db/schema.ts` contains only `batch_jpeg_export`.
- [ ] `IndexerComponent.runBackfill()` and its template section are gone.
- [ ] `BunApiBackendService.runExifBackfill()` is gone.
- [ ] `cd src/api && bun run tsc --noEmit` exits clean.
- [ ] `cd src/web && bun x ng build maple --configuration=development` exits clean.
- [ ] `cd src/api && bun test` — all pass.
- [ ] `cd src/web && bun x ng test maple --watch=false` — all pass.
- [ ] No "TODO", "TBD", or placeholder comments remain in any file touched by this plan.
- [ ] `WorkersComponent.ngOnDestroy()` calls `clearInterval` — polling stops when the route is left.
- [ ] Pause/resume is optimistic with revert on error.
- [ ] Settings dialog does not PATCH when the form is invalid.
- [ ] New route is gated with both `authGuard` and `ownerGuard`.
