import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { BatchSyncBannerComponent } from './batch-sync-banner.component';
import { BatchSyncService } from './batch-sync.service';

function renderFailures(count: number) {
  const failures = Array.from({ length: count }, (_, index) => ({
    id: `photo-${index}`,
    reason: 'Sidecar permission denied',
  }));
  const summary = { applied: [], failed: failures, cancelled: false };
  TestBed.configureTestingModule({
    imports: [BatchSyncBannerComponent],
    providers: [
      {
        provide: BatchSyncService,
        useValue: {
          error: signal(null),
          progress: signal(null),
          summaryText: signal(`0 images updated · ${count} failed`),
          lastSummary: signal(summary),
          remaining: signal([]),
          failedIds: signal(failures.map((failure) => failure.id)),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(BatchSyncBannerComponent);
  fixture.detectChanges();
  return { fixture, summary };
}

describe('batch sync failure banner', () => {
  it('bounds a 2,000-photo failure list while retaining every failure for retry', () => {
    const { fixture, summary } = renderFailures(2000);
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="batch-sync-failure"]');
    expect(rows).toHaveLength(5);
    expect(rows[0].textContent).toContain('photo-0');
    expect(rows[4].textContent).toContain('photo-4');
    expect(fixture.nativeElement.textContent).toContain('And 1995 more failures');
    let retries = 0;
    fixture.componentInstance.retryFailed.subscribe(() => retries++);
    fixture.nativeElement.querySelector('[data-testid="batch-sync-retry"]').click();
    expect(retries).toBe(1);
    expect(summary.failed).toHaveLength(2000);
    expect(summary.failed.at(-1)?.id).toBe('photo-1999');
  });

  it('shows each failure without an extra count for a small batch', () => {
    const { fixture } = renderFailures(3);
    expect(
      fixture.nativeElement.querySelectorAll('[data-testid="batch-sync-failure"]'),
    ).toHaveLength(3);
    expect(fixture.nativeElement.textContent).not.toContain('more failures');
  });
});
