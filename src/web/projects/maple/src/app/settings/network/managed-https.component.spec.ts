import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedHttpsComponent } from './managed-https.component';
import type { ManagedHttpsResponse } from './managed-https.service';

const response: ManagedHttpsResponse = {
  config: {
    enabled: true,
    hostname: 'local.example.com',
    port: 3443,
    email: 'owner@example.com',
    zone_id: 'a'.repeat(32),
    api_token_set: true,
    http3: true,
    terms_agreed: true,
  },
  status: {
    state: 'ready',
    expires_at: Date.now() + 86400_000,
    retry_at: null,
    error: null,
    http3: true,
  },
};
describe('ManagedHttpsComponent', () => {
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ManagedHttpsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  async function render() {
    const fixture = TestBed.createComponent(ManagedHttpsComponent);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 5));
    http.expectOne('/api/network/https/').flush(response);
    fixture.detectChanges();
    return fixture;
  }
  it('shows certificate status and preserves a write-only token on save', async () => {
    const fixture = await render();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('HTTPS ready');
    const token = el.querySelector<HTMLInputElement>(
      'input[aria-label="Cloudflare DNS API token"]',
    )!;
    expect(token.type).toBe('password');
    expect(token.value).toBe('');
    el.querySelector<HTMLButtonElement>('mui-button button')!.click();
    const request = http.expectOne('/api/network/https/');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).not.toHaveProperty('api_token');
    expect(request.request.body.hostname).toBe('local.example.com');
    request.flush(response);
    await Promise.resolve();
    fixture.destroy();
  });
  it('sends null to clear the saved token, but a newly typed token wins over the clear tick', async () => {
    const fixture = await render();
    const el: HTMLElement = fixture.nativeElement;
    const component = fixture.componentInstance as unknown as {
      clearToken: { set(value: boolean): void };
      token: { set(value: string): void };
    };
    const saveButton = el.querySelector<HTMLButtonElement>('mui-button button')!;
    component.clearToken.set(true);
    saveButton.click();
    const cleared = http.expectOne('/api/network/https/');
    expect(cleared.request.body.api_token).toBeNull();
    cleared.flush({ ...response, config: { ...response.config, api_token_set: false } });
    await Promise.resolve();
    component.clearToken.set(true);
    component.token.set('  cf-token  ');
    saveButton.click();
    const typed = http.expectOne('/api/network/https/');
    expect(typed.request.body.api_token).toBe('cf-token');
    typed.flush(response);
    await Promise.resolve();
    expect(
      el.querySelector<HTMLInputElement>('input[aria-label="Cloudflare DNS API token"]')!.value,
    ).toBe('');
    fixture.destroy();
  });
  it('shows failed renewal and the next retry while retaining the existing expiry', async () => {
    const fixture = TestBed.createComponent(ManagedHttpsComponent);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 5));
    http.expectOne('/api/network/https/').flush({
      ...response,
      status: {
        ...response.status,
        state: 'error',
        error: 'DNS permissions need attention.',
        retry_at: Date.now() + 3600_000,
      },
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('DNS permissions need attention.');
    expect(fixture.nativeElement.textContent).toContain('Next certificate attempt:');
    fixture.destroy();
  });
});
