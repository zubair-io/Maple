import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkersComponent } from './workers.component';
import { API_BASE_URL } from '@maple-common';
import type { WorkersStatusResponse } from '@maple-common';

const MOCK_CONFIG = { concurrency: 4, pollIntervalMs: 1000, batchSize: 10, maxAttempts: 5, paused: false, last_seen_target_version: 1 };

const MOCK_RESPONSE: WorkersStatusResponse = {
  stages: [
    {
      name: 'hash',
      status: 'running',
      inFlight: 3,
      configured: 4,
      pending: 1247,
      dead: 0,
      throughput: 18,
      lastError: null,
      config: MOCK_CONFIG,
      batchSize: 10,
    },
    {
      name: 'face',
      status: 'running',
      inFlight: 1,
      configured: 2,
      pending: 842,
      dead: 3,
      throughput: 6,
      lastError: null,
      config: { concurrency: 2, pollIntervalMs: 1000, batchSize: 5, maxAttempts: 5, paused: false, last_seen_target_version: 1 },
      batchSize: 5,
    },
    {
      name: 'describe',
      status: 'error',
      inFlight: 0,
      configured: 2,
      pending: 842,
      dead: 0,
      throughput: 0,
      lastError: 'API key invalid',
      config: { concurrency: 2, pollIntervalMs: 1000, batchSize: 5, maxAttempts: 5, paused: false, last_seen_target_version: 1 },
      batchSize: 5,
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
    fixture.detectChanges(); // triggers ngOnInit → scheduleNextPoll(0) → immediate poll
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

  it('renders Workers column as inFlight/configured', () => {
    initWithMock();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    expect(row.querySelector('[data-testid="workers"]')?.textContent?.trim()).toBe('3 / 4');
  });

  it('renders In flight as inFlight/batchSize', () => {
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

  it('hydrates configs from status poll', () => {
    initWithMock();
    expect(component.configs()['hash']).toEqual(MOCK_CONFIG);
  });

  it('pause button POSTs /api/workers/hash/pause', () => {
    initWithMock();

    const row: HTMLElement = fixture.nativeElement.querySelectorAll('[data-testid="worker-row"]')[0];
    row.querySelector<HTMLButtonElement>('[data-testid="pause-resume-btn"]')?.click();

    http.expectOne({ method: 'POST', url: '/api/workers/hash/pause' }).flush(null, { status: 204, statusText: '' });
    fixture.detectChanges();
  });
});
