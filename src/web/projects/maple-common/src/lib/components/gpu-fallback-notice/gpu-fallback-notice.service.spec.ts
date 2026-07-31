// GpuFallbackNoticeService (#2415) — the pure state machine behind the
// "editing is running on a reduced-performance path" notice.

import { describe, it, expect, beforeEach } from 'vitest';
import { GpuFallbackNoticeService } from './gpu-fallback-notice.service';

describe('GpuFallbackNoticeService', () => {
  let service: GpuFallbackNoticeService;

  beforeEach(() => {
    service = new GpuFallbackNoticeService();
  });

  it('starts hidden with no reason recorded', () => {
    expect(service.visible()).toBe(false);
    expect(service.message()).toBe('');
  });

  it('report("insecure-context") becomes visible with the HTTPS-pointing message', () => {
    service.report('insecure-context');
    expect(service.visible()).toBe(true);
    expect(service.message()).toContain('HTTPS');
  });

  it('report("session-open-failed") becomes visible WITHOUT mentioning HTTPS (not a fixable-by-scheme failure)', () => {
    service.report('session-open-failed');
    expect(service.visible()).toBe(true);
    expect(service.message()).not.toContain('HTTPS');
  });

  it('the first reported reason wins — a later report does not overwrite it', () => {
    service.report('insecure-context');
    service.report('session-open-failed');
    expect(service.message()).toContain('HTTPS');
  });

  it('dismiss() hides the notice without clearing the recorded reason', () => {
    service.report('insecure-context');
    service.dismiss();
    expect(service.visible()).toBe(false);
    // A later report (from a different asset failing the same way) stays
    // suppressed — dismissal is for the rest of the page session.
    service.report('insecure-context');
    expect(service.visible()).toBe(false);
  });

  it('clear() hides the notice and allows a later report to show again', () => {
    service.report('session-open-failed');
    service.clear();
    expect(service.visible()).toBe(false);
    service.report('insecure-context');
    expect(service.visible()).toBe(true);
    expect(service.message()).toContain('HTTPS');
  });
});
