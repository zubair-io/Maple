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

  function inputByLabel(ariaLabel: string): HTMLInputElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      `mui-input input[aria-label="${ariaLabel}"]`,
    );
    if (!el) throw new Error(`missing input labeled ${ariaLabel}`);
    return el;
  }

  function enabledCheckbox(): HTMLInputElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'mui-checkbox input[type="checkbox"]',
    );
    if (!el) throw new Error('missing enabled checkbox');
    return el;
  }

  function clickSave(): void {
    const btn = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.form-actions:not(.test-actions) mui-button button',
    );
    if (!btn) throw new Error('missing save button');
    btn.click();
  }

  it('seeds the form from the loaded config, leaving the secret field blank', async () => {
    await load();
    expect(inputByLabel('Account ID').value).toBe('acct123');
    expect(inputByLabel('Bucket name').value).toBe('maple-thumbs');
    expect(inputByLabel('Access key ID').value).toBe('AKIAEXAMPLE');
    expect(inputByLabel('Secret access key').value).toBe('');
    expect(enabledCheckbox().checked).toBe(false);
  });

  it('omits secret_access_key from the PUT patch when the field is left blank', async () => {
    await load();
    const enabled = enabledCheckbox();
    enabled.click();
    fixture.detectChanges();
    await fixture.whenStable();

    clickSave();

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
    const secret = inputByLabel('Secret access key');
    secret.value = 'new-secret';
    secret.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();

    clickSave();

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

  it('points to Settings → Workers for syncing thumbnails, with no trigger of its own', async () => {
    await load();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('cf-thumb-sync');
    const workersLink = el.querySelector('a[href="/settings/workers"]');
    expect(workersLink).toBeTruthy();
    // No backfill/sync endpoints exist anymore — HttpTestingController's
    // afterEach http.verify() would fail this test if one fired.
    expect(
      Array.from(el.querySelectorAll('button')).some((b) =>
        b.textContent?.includes('Sync existing thumbnails'),
      ),
    ).toBe(false);
  });
});
