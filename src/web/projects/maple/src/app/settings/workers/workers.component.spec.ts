import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkersComponent } from './workers.component';
import { API_BASE_URL } from '@maple-common';
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
      imports: [WorkersComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
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

  function initWithMock(): void {
    fixture.detectChanges(); // triggers ngOnInit → poll()
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    fixture.detectChanges();
  }

  it('fetches status on init and renders one row per stage', () => {
    initWithMock();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]');
    expect(rows.length).toBe(3);
  });

  it('renders Status column correctly', () => {
    initWithMock();

    const rows: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]');
    const hashRow = rows[0];
    expect(hashRow.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Running');
    const descRow = rows[2];
    expect(descRow.querySelector('[data-testid="status"]')?.textContent?.trim()).toBe('Error');
  });

  it('renders Workers column as active/configured', () => {
    initWithMock();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="workers"]')?.textContent?.trim()).toBe('4 / 4');
  });

  it('renders In flight as dispatched/batch_size', () => {
    initWithMock();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="in-flight"]')?.textContent?.trim()).toBe('3 / 10');
  });

  it('renders Pending count', () => {
    initWithMock();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="pending"]')?.textContent?.trim()).toBe('1,247');
  });

  it('renders Dead count with retry button when dead > 0', () => {
    initWithMock();

    const faceRow: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[1];
    expect(faceRow.querySelector('[data-testid="dead-count"]')?.textContent?.trim()).toBe('3');
    expect(faceRow.querySelector('[data-testid="retry-dead-btn"]')).toBeTruthy();

    const hashRow: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(hashRow.querySelector('[data-testid="retry-dead-btn"]')).toBeNull();
  });

  it('renders Throughput as n /min', () => {
    initWithMock();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="throughput"]')?.textContent?.trim()).toBe('18 /min');
  });

  it('renders — for throughput when zero', () => {
    initWithMock();

    const descRow: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[2];
    expect(descRow.querySelector('[data-testid="throughput"]')?.textContent?.trim()).toBe('—');
  });

  it('pause button POSTs /api/workers/hash/pause and re-polls', () => {
    initWithMock();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    row.querySelector<HTMLButtonElement>('[data-testid="pause-resume-btn"]')?.click();

    // optimistic update — no need to wait
    http.expectOne({ method: 'POST', url: '/api/workers/hash/pause' }).flush(null, { status: 204, statusText: '' });
    // re-poll after success
    http.expectOne('/api/workers/status').flush(MOCK_RESPONSE);
    fixture.detectChanges();
  });
});
