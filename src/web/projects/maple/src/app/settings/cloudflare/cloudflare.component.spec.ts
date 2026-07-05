import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { API_BASE_URL, type CloudflareConfig } from '@maple-common';
import { CloudflareComponent } from './cloudflare.component';

const CONFIG: CloudflareConfig = {
  enabled: false,
  account_id: 'acct123',
  bucket: 'maple-thumbs',
  access_key_id: 'AKIAEXAMPLE',
  secret_access_key_set: true,
};

describe('CloudflareComponent', () => {
  let fixture: ComponentFixture<CloudflareComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CloudflareComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CloudflareComponent);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function load(): Promise<void> {
    fixture.detectChanges(); // ngOnInit → GET config
    http.expectOne('/api/cloudflare/config').flush(CONFIG);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function input(sel: string): HTMLInputElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(sel);
    if (!el) throw new Error(`missing element ${sel}`);
    return el;
  }

  it('seeds the form from the loaded config, leaving the secret field blank', async () => {
    await load();
    expect(input('#cf-account-id').value).toBe('acct123');
    expect(input('#cf-bucket').value).toBe('maple-thumbs');
    expect(input('#cf-access-key-id').value).toBe('AKIAEXAMPLE');
    expect(input('#cf-secret-access-key').value).toBe('');
    expect(input('#cf-enabled').checked).toBe(false);
  });

  it('omits secret_access_key from the PUT patch when the field is left blank', async () => {
    await load();
    const enabled = input('#cf-enabled');
    enabled.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const form = (fixture.nativeElement as HTMLElement).querySelector('form');
    form?.dispatchEvent(new Event('submit'));

    const call = http.expectOne('/api/cloudflare/config');
    expect(call.request.method).toBe('PUT');
    expect(call.request.body).toEqual({
      enabled: true,
      account_id: 'acct123',
      bucket: 'maple-thumbs',
      access_key_id: 'AKIAEXAMPLE',
    });
    call.flush({ ...CONFIG, enabled: true });
  });

  it('includes a freshly-typed secret_access_key in the PUT patch', async () => {
    await load();
    const secret = input('#cf-secret-access-key');
    secret.value = 'new-secret';
    secret.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    const form = (fixture.nativeElement as HTMLElement).querySelector('form');
    form?.dispatchEvent(new Event('submit'));

    const call = http.expectOne('/api/cloudflare/config');
    expect(call.request.body).toMatchObject({ secret_access_key: 'new-secret' });
    call.flush({ ...CONFIG, secret_access_key_set: true });
  });

  it('shows the load error state when the config fetch fails', () => {
    fixture.detectChanges();
    http
      .expectOne('/api/cloudflare/config')
      .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('boom');
  });

  it('never calls GET /api/auth/jwt-secret — the app does not surface the secret', async () => {
    await load();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('retrieve it directly');
    // HttpTestingController's afterEach http.verify() would itself fail if
    // any unexpected request (including a jwt-secret call) had fired.
  });

  describe('backfill panel', () => {
    async function loadComplete(): Promise<void> {
      fixture.detectChanges();
      http.expectOne('/api/cloudflare/config').flush({ ...CONFIG, enabled: true });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    it('shows a disabled hint instead of the sync button when config is incomplete', async () => {
      await load(); // CONFIG has enabled: false
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Enable uploads and save valid credentials');
      expect(
        Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).some((b) =>
          b.textContent?.includes('Sync existing thumbnails'),
        ),
      ).toBe(false);
    });

    it('queues a backfill job and polls its status once config is complete', async () => {
      await loadComplete();
      const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
      const syncBtn = buttons.find((b) => b.textContent?.includes('Sync existing thumbnails'));
      expect(syncBtn).toBeTruthy();
      syncBtn!.click();
      fixture.detectChanges();

      const create = http.expectOne('/api/cloudflare/backfill');
      expect(create.request.method).toBe('POST');
      create.flush({ id: 'job1' });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const poll = http.expectOne('/api/cloudflare/backfill/job1');
      expect(poll.request.method).toBe('GET');
      poll.flush({
        id: 'job1',
        status: 'running',
        progress: { current: 3, total: 10 },
        result: null,
        error: null,
        cancel_requested: false,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Syncing 3 / 10');

      // Stop the still-armed poll interval so it can't fire an unexpected
      // request after this test's HttpTestingController.verify() runs.
      fixture.destroy();
    });

    it('shows the done summary and stops polling once the job completes', async () => {
      await loadComplete();
      const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
      const syncBtn = buttons.find((b) => b.textContent?.includes('Sync existing thumbnails'));
      syncBtn!.click();
      fixture.detectChanges();

      http.expectOne('/api/cloudflare/backfill').flush({ id: 'job2' });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      http.expectOne('/api/cloudflare/backfill/job2').flush({
        id: 'job2',
        status: 'done',
        progress: { current: 5, total: 5 },
        result: { successCount: 4, skippedCount: 1, failedCount: 0, failures: [] },
        error: null,
        cancel_requested: false,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('Done — 4 uploaded, 1 skipped, 0 failed.');
      // A completed job leaves the sync button visible again (isRunning() is
      // false), rather than stuck showing a progress bar.
      expect(
        Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).some((b) =>
          b.textContent?.includes('Sync existing thumbnails'),
        ),
      ).toBe(true);
    });
  });
});
