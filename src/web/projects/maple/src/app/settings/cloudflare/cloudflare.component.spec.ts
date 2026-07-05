import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { API_BASE_URL, type CloudflareConfig } from '@maple-common';
import { CloudflareComponent } from './cloudflare.component';

// The JWT-secret reveal now requires a step-up assertion (#861 parity — see
// review on #1764), which routes through AuthService.stepUp() and the
// browser WebAuthn API. jsdom has no navigator.credentials, so stub the
// module-level `startAuthentication` call; its return value is opaque to
// our mocked HTTP layer below (the flushed responses are what matter).
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn().mockResolvedValue({}),
}));

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

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function input(sel: string): HTMLInputElement {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(sel);
    if (!el) throw new Error(`missing element ${sel}`);
    return el;
  }

  function click(sel: string): void {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(sel);
    if (!el) throw new Error(`missing element ${sel}`);
    el.click();
  }

  /** Flush the step-up round trip (`AuthService.stepUp()`) that now gates
   * `GET /api/auth/jwt-secret`, then flush the secret endpoint itself. */
  async function flushJwtSecretReveal(secret: string): Promise<void> {
    await tick(); // let stepUp()'s first POST fire before we look for it
    http.expectOne('/api/auth/step-up/options').flush({});
    await tick();
    http.expectOne('/api/auth/step-up/verify').flush({ step_up_token: 'stepup-token' });
    await tick();
    const call = http.expectOne('/api/auth/jwt-secret');
    expect(call.request.headers.get('X-Step-Up')).toBe('stepup-token');
    call.flush({ secret });
    await tick();
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

  it('reveals the JWT secret only after an explicit click, not on load', async () => {
    await load();
    expect((fixture.nativeElement as HTMLElement).textContent?.includes('super-secret-value')).toBe(
      false,
    );

    click('.jwt-panel button');
    await flushJwtSecretReveal('super-secret-value');
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('super-secret-value');
  });

  it('copies the revealed secret to the clipboard', async () => {
    await load();
    click('.jwt-panel button');
    await flushJwtSecretReveal('super-secret-value');
    fixture.detectChanges();

    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    try {
      const copyBtn = Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('.secret-box button'),
      ).find((b) => b.textContent?.trim() === 'Copy') as HTMLButtonElement;
      copyBtn.click();

      expect(writeText).toHaveBeenCalledWith('super-secret-value');
    } finally {
      Object.assign(navigator, { clipboard: originalClipboard });
    }
  });
});
