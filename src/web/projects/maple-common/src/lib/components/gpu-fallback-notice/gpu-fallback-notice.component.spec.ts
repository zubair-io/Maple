// GpuFallbackNoticeComponent (#2415) — view wiring over GpuFallbackNoticeService.

import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { GpuFallbackNoticeComponent } from './gpu-fallback-notice.component';
import { GpuFallbackNoticeService } from './gpu-fallback-notice.service';

describe('GpuFallbackNoticeComponent', () => {
  let fixture: ComponentFixture<GpuFallbackNoticeComponent>;
  let service: GpuFallbackNoticeService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [GpuFallbackNoticeComponent] });
    fixture = TestBed.createComponent(GpuFallbackNoticeComponent);
    service = TestBed.inject(GpuFallbackNoticeService);
    fixture.detectChanges();
  });

  it('renders nothing when no fallback has been reported', () => {
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
  });

  it('renders the insecure-context message once reported, pointing at HTTPS', () => {
    service.report('insecure-context');
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('[role="status"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('HTTPS');
  });

  it('does not render for a browser that never lost the GPU path', () => {
    // Simulates the successful-open case: nothing ever calls report().
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
  });

  it('clicking Dismiss hides the notice', () => {
    service.report('session-open-failed');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="status"]')).not.toBeNull();

    const dismissBtn = fixture.nativeElement.querySelector(
      'button[aria-label="Dismiss"]',
    ) as HTMLButtonElement;
    dismissBtn.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();
  });
});
