import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { DeadLetterDialogComponent } from './dead-letter-dialog.component';
import { API_BASE_URL } from '@maple-common';
import type { DeadListResponse, StageStatus } from '@maple-common';

const STAGE: StageStatus = {
  name: 'describe',
  status: 'running',
  inFlight: 1,
  configured: 2,
  pending: 100,
  dead: 3,
  throughput: 0,
  lastError: null,
  config: { concurrency: 2, pollIntervalMs: 1000, batchSize: 5, maxAttempts: 5, paused: false, last_seen_target_version: 1 },
  batchSize: 5,
};

const ITEMS: DeadListResponse = {
  items: [
    { id: 'a1', abs_path: '/photos/2024/IMG_0042.dng', last_error: 'fetch failed: 503', attempts: 5, processed_at: '2026-05-11T05:10:00.000Z' },
    { id: 'a2', abs_path: '/photos/2024/IMG_1337.dng', last_error: 'timeout after 60000ms', attempts: 5, processed_at: '2026-05-11T05:08:11.000Z' },
  ],
};

describe('DeadLetterDialogComponent', () => {
  let fixture: ComponentFixture<DeadLetterDialogComponent>;
  let component: DeadLetterDialogComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DeadLetterDialogComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DeadLetterDialogComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('stage', STAGE);
    fixture.detectChanges(); // triggers ngOnInit → GET dispatched synchronously
  });

  afterEach(() => http.verify());

  it('issues GET /api/workers/<stage>/dead on init for the provided stage', () => {
    const req = http.expectOne('/api/workers/describe/dead?limit=50');
    expect(req.request.method).toBe('GET');
    req.flush({ items: [] });
  });

  it('renders one row per dead doc once the response lands', () => {
    http.expectOne('/api/workers/describe/dead?limit=50').flush(ITEMS);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="dead-row"]');
    expect(rows.length).toBe(2);
    const firstReason = rows[0].querySelector('[data-testid="dead-reason"]')?.textContent?.trim();
    expect(firstReason).toBe('fetch failed: 503');
  });

  it('renders the error banner when the request fails', () => {
    http.expectOne('/api/workers/describe/dead?limit=50').flush(
      { error: 'boom' },
      { status: 500, statusText: 'Server Error' },
    );
    fixture.detectChanges();
    expect(component.loading()).toBe(false);
    expect(component.loadError()).toBe('boom');
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('boom');
  });

  it('shows the empty-state message when items is empty', () => {
    http.expectOne('/api/workers/describe/dead?limit=50').flush({ items: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No dead-lettered docs');
  });

  it('emits cancelled on Escape', () => {
    http.expectOne('/api/workers/describe/dead?limit=50').flush({ items: [] });
    let cancelled = false;
    component.cancelled.subscribe(() => (cancelled = true));
    component.onEscape();
    expect(cancelled).toBe(true);
  });

  it('emits cancelled on close()', () => {
    http.expectOne('/api/workers/describe/dead?limit=50').flush({ items: [] });
    let cancelled = false;
    component.cancelled.subscribe(() => (cancelled = true));
    component.close();
    expect(cancelled).toBe(true);
  });

  it('fileName() strips the leading directory path', () => {
    http.expectOne('/api/workers/describe/dead?limit=50').flush({ items: [] });
    expect(component.fileName('/photos/2024/IMG_0042.dng')).toBe('IMG_0042.dng');
    expect(component.fileName(null)).toBe('(unknown path)');
    expect(component.fileName('plain.txt')).toBe('plain.txt');
  });
});
