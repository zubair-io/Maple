import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { WorkerConfigDialogComponent } from './worker-config-dialog.component';
import { API_BASE_URL } from '@maple-common';
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
    // Set required signal inputs via ComponentRef.setInput() — the correct
    // API for signal-based inputs (input.required<T>()) in TestBed.
    fixture.componentRef.setInput('stage', STAGE);
    fixture.componentRef.setInput('config', { concurrency: 4, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5 });
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

  it('PATCHes /api/workers/exif/config on save with valid form', () => {
    component.form.setValue({ concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 });
    let emitted = false;
    component.saved.subscribe(() => (emitted = true));
    component.save();
    const req = http.expectOne('/api/workers/exif/config');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 });
    req.flush({ config: { concurrency: 8, pollIntervalMs: 2000, batchSize: 15, maxAttempts: 5 } });
    expect(emitted).toBe(true);
  });

  it('does not PATCH when form is invalid', () => {
    component.form.controls['concurrency'].setValue(0);
    component.save();
    http.expectNone('/api/workers/exif/config');
  });
});
