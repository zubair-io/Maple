import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MuiResultReportModalComponent } from './mui-result-report-modal.component';
import type { MuiResultItem } from './mui-result-report-modal.component';

const RESULTS: MuiResultItem[] = [
  { id: 'r1', label: 'IMG_0001.dng', status: 'success' },
  { id: 'r2', label: 'IMG_0002.dng', status: 'error', detail: 'Disk full' },
  { id: 'r3', label: 'IMG_0003.dng', status: 'skipped' },
];

@Component({
  standalone: true,
  imports: [MuiResultReportModalComponent],
  template: `
    <mui-result-report-modal
      [open]="open()"
      [results]="results()"
      (dismissed)="dismissedCount = dismissedCount + 1"
      (retryFailedRequested)="lastRetry = $event"
    />
  `,
})
class HostComponent {
  readonly open = signal(true);
  readonly results = signal<readonly MuiResultItem[]>(RESULTS);
  dismissedCount = 0;
  lastRetry: readonly string[] | null = null;
}

function render(): { fixture: ComponentFixture<HostComponent>; host: HostComponent } {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance };
}

describe('MuiResultReportModalComponent', () => {
  it('renders a badge per row with the status-appropriate variant and label', () => {
    const { fixture } = render();
    const badges = (fixture.nativeElement as HTMLElement).querySelectorAll('mui-badge .mui-badge');
    expect(badges.length).toBe(3);
    expect(badges[0].className).toContain('variant-count');
    expect(badges[0].textContent).toContain('Success');
    expect(badges[1].className).toContain('variant-signal');
    expect(badges[1].textContent).toContain('Error');
  });

  it('shows the empty state when there are no results', () => {
    const { fixture, host } = render();
    host.results.set([]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mui-empty-state')).not.toBeNull();
    expect(el.querySelectorAll('mui-list-row').length).toBe(0);
  });

  it('emits retryFailedRequested with only the failed ids', () => {
    const { fixture, host } = render();
    const el = fixture.nativeElement as HTMLElement;
    const retryBtn = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Retry'),
    ) as HTMLButtonElement;
    retryBtn.click();
    expect(host.lastRetry).toEqual(['r2']);
  });

  it('hides the retry button when nothing failed', () => {
    const { fixture, host } = render();
    host.results.set([{ id: 'r1', label: 'ok.dng', status: 'success' }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const retryBtn = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Retry'),
    );
    expect(retryBtn).toBeUndefined();
  });

  it('emits dismissed on scrim click', () => {
    const { fixture, host } = render();
    (fixture.nativeElement.querySelector('.mui-overlay-shell-scrim') as HTMLElement).click();
    expect(host.dismissedCount).toBe(1);
  });
});
