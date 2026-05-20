import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { WorkerConfigDialogComponent } from './worker-config-dialog.component';
import { API_BASE_URL } from '@maple-common';
import type { StageStatus } from '@maple-common';

const STAGE: StageStatus = {
  name: 'exif',
  status: 'running',
  inFlight: 2,
  configured: 4,
  pending: 500,
  dead: 0,
  throughput: 12,
  lastError: null,
  config: { concurrency: 4, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5, paused: false, last_seen_target_version: 1 },
  batchSize: 10,
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
    // Set required signal inputs via ComponentRef.setInput() — the correct
    // API for signal-based inputs (input.required<T>()) in TestBed.
    fixture.componentRef.setInput('stage', STAGE);
    fixture.componentRef.setInput('config', { concurrency: 4, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5, paused: false, last_seen_target_version: 1 });
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
    expect(component.form.controls['concurrency'].valid).toBe(false);
    component.form.controls['concurrency'].setValue(33);
    expect(component.form.controls['concurrency'].valid).toBe(false);
    component.form.controls['concurrency'].setValue(8);
    expect(component.form.controls['concurrency'].valid).toBe(true);
  });

  it('validates pollIntervalMs must be 100–60000', () => {
    component.form.controls['pollIntervalMs'].setValue(50);
    expect(component.form.controls['pollIntervalMs'].valid).toBe(false);
    component.form.controls['pollIntervalMs'].setValue(99999);
    expect(component.form.controls['pollIntervalMs'].valid).toBe(false);
    component.form.controls['pollIntervalMs'].setValue(2000);
    expect(component.form.controls['pollIntervalMs'].valid).toBe(true);
  });

  it('validates batchSize must be 1–100', () => {
    component.form.controls['batchSize'].setValue(0);
    expect(component.form.controls['batchSize'].valid).toBe(false);
    component.form.controls['batchSize'].setValue(101);
    expect(component.form.controls['batchSize'].valid).toBe(false);
    component.form.controls['batchSize'].setValue(20);
    expect(component.form.controls['batchSize'].valid).toBe(true);
  });

  it('validates maxAttempts must be 1–20', () => {
    component.form.controls['maxAttempts'].setValue(0);
    expect(component.form.controls['maxAttempts'].valid).toBe(false);
    component.form.controls['maxAttempts'].setValue(21);
    expect(component.form.controls['maxAttempts'].valid).toBe(false);
    component.form.controls['maxAttempts'].setValue(10);
    expect(component.form.controls['maxAttempts'].valid).toBe(true);
  });

  it('PATCHes /api/workers/exif/config on save and emits saved with config', () => {
    component.form.setValue({ concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 });
    let emittedConfig: unknown;
    component.saved.subscribe((c) => (emittedConfig = c));
    component.save();
    const req = http.expectOne('/api/workers/exif/config');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 });
    req.flush({ ok: true, config: { concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 } });
    expect((emittedConfig as { concurrency: number })?.concurrency).toBe(8);
  });

  it('falls back to form values when server returns null config', () => {
    component.form.setValue({ concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 });
    let emittedConfig: unknown;
    component.saved.subscribe((c) => (emittedConfig = c));
    component.save();
    http.expectOne('/api/workers/exif/config').flush({ ok: true, config: null });
    expect((emittedConfig as { concurrency: number })?.concurrency).toBe(8);
  });

  it('does not PATCH when form is invalid', () => {
    component.form.controls['concurrency'].setValue(0);
    component.save();
    http.expectNone('/api/workers/exif/config');
  });

  it('emits cancelled on escape key', () => {
    let cancelled = false;
    component.cancelled.subscribe(() => (cancelled = true));
    component.onEscape();
    expect(cancelled).toBe(true);
  });

  it('preserves in-progress form edits when the config input changes (polling)', () => {
    // User starts editing while the dialog is open.
    component.form.controls['concurrency'].setValue(16);
    expect(component.form.controls['concurrency'].value).toBe(16);

    // Parent re-polls and emits a fresh config object (new identity, same
    // persisted values). The dialog must NOT overwrite the user's edit.
    fixture.componentRef.setInput('config', {
      concurrency: 4,
      pollIntervalMs: 1000,
      batchSize: 10,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: 1,
    });
    fixture.detectChanges();

    expect(component.form.controls['concurrency'].value).toBe(16);
  });
});
