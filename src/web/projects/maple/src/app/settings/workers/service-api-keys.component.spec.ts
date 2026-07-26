import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { AuthService, type CreatedServiceApiKey, type ServiceApiKey } from '@maple-common';
import { ServiceApiKeysComponent } from './service-api-keys.component';

describe('ServiceApiKeysComponent', () => {
  let fixture: ComponentFixture<ServiceApiKeysComponent>;

  const key = (overrides: Partial<ServiceApiKey> = {}): ServiceApiKey => ({
    keyId: '0000000000000001',
    prefix: 'maple_sk_0123456789abcdef',
    name: 'SugarMaple',
    scopes: ['assets:search'],
    createdAt: '2026-07-26T12:00:00.000Z',
    expiresAt: '2026-10-24T12:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  });

  const created = (): CreatedServiceApiKey => ({
    key: 'test-service-key-once-only',
    keyId: '0000000000000001',
    prefix: 'maple_sk_0123456789abcdef',
    name: 'SugarMaple',
    scopes: ['assets:search'],
    createdAt: '2026-07-26T12:00:00.000Z',
    expiresAt: '2026-10-24T12:00:00.000Z',
  });

  async function setup(authStub: Partial<AuthService>): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [ServiceApiKeysComponent],
      providers: [{ provide: AuthService, useValue: authStub }],
    }).compileComponents();
    fixture = TestBed.createComponent(ServiceApiKeysComponent);
  }

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('explains the restricted Maple endpoint and renders existing key metadata', async () => {
    await setup({ listServiceApiKeys: () => of([key()]) });
    fixture.detectChanges();

    expect(element().textContent).toContain('cannot access Meilisearch directly');
    expect(element().textContent).toContain('/api/search/assets');
    expect(element().textContent).toContain('maple_sk_0123456789abcdef…');
    expect(element().textContent).toContain('Active');
    expect(element().textContent).toContain('never used');
  });

  it('generates a 90-day key and shows its plaintext secret once', async () => {
    const createServiceApiKey = vi.fn().mockResolvedValue(created());
    const listServiceApiKeys = vi
      .fn()
      .mockReturnValueOnce(of([]))
      .mockReturnValueOnce(of([key()]));
    await setup({ listServiceApiKeys, createServiceApiKey });
    fixture.detectChanges();

    element().querySelector<HTMLButtonElement>('form .btn-primary')!.click();
    await settle();

    expect(createServiceApiKey).toHaveBeenCalledOnce();
    const [name, expiresAt] = createServiceApiKey.mock.calls[0] as [string, string];
    expect(name).toBe('SugarMaple');
    const expiryDays = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(expiryDays).toBeGreaterThan(89);
    expect(expiryDays).toBeLessThanOrEqual(90);
    expect(element().textContent).toContain('test-service-key-once-only');
    expect(element().textContent).toContain('will not be shown again');

    element().querySelector<HTMLButtonElement>('.dismiss-btn')!.click();
    fixture.detectChanges();
    expect(element().textContent).not.toContain('test-service-key-once-only');
  });

  it('ignores repeated form submissions while passkey step-up is pending', async () => {
    let resolveCreate!: (value: CreatedServiceApiKey) => void;
    const pendingCreate = new Promise<CreatedServiceApiKey>((resolve) => {
      resolveCreate = resolve;
    });
    const createServiceApiKey = vi.fn().mockReturnValue(pendingCreate);
    const listServiceApiKeys = vi
      .fn()
      .mockReturnValueOnce(of([]))
      .mockReturnValueOnce(of([key()]));
    await setup({ listServiceApiKeys, createServiceApiKey });
    fixture.detectChanges();

    const form = element().querySelector<HTMLFormElement>('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    expect(createServiceApiKey).toHaveBeenCalledOnce();

    resolveCreate(created());
    await settle();
  });

  it('copies the one-time key to the clipboard', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      userAgent: 'jsdom',
      clipboard: { writeText },
    });
    await setup({
      listServiceApiKeys: () => of([]),
      createServiceApiKey: vi.fn().mockResolvedValue(created()),
    });
    fixture.detectChanges();

    element().querySelector<HTMLButtonElement>('form .btn-primary')!.click();
    await settle();
    vi.useFakeTimers();
    element().querySelector<HTMLButtonElement>('.secret-row .btn-primary')!.click();
    await settle();

    expect(element().textContent).toContain('Could not copy automatically.');

    element().querySelector<HTMLButtonElement>('.secret-row .btn-primary')!.click();
    await settle();

    expect(writeText).toHaveBeenLastCalledWith(created().key);
    expect(element().textContent).not.toContain('Could not copy automatically.');
    expect(element().textContent).toContain('Copied');

    element().querySelector<HTMLButtonElement>('form .btn-primary')!.click();
    await settle();

    expect(element().textContent).not.toContain('Copied');

    element().querySelector<HTMLButtonElement>('.secret-row .btn-primary')!.click();
    await settle();
    expect(element().textContent).toContain('Copied');

    await vi.advanceTimersByTimeAsync(2_000);
    fixture.detectChanges();

    expect(element().textContent).not.toContain('Copied');
  });

  it('revokes a confirmed key and refreshes the list', async () => {
    const revokeServiceApiKey = vi.fn().mockResolvedValue(undefined);
    const listServiceApiKeys = vi
      .fn()
      .mockReturnValueOnce(of([key()]))
      .mockReturnValueOnce(of([key({ revokedAt: '2026-07-27T12:00:00.000Z' })]));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    await setup({ listServiceApiKeys, revokeServiceApiKey });
    fixture.detectChanges();

    element().querySelector<HTMLButtonElement>('.revoke-btn')!.click();
    await settle();

    expect(revokeServiceApiKey).toHaveBeenCalledWith('0000000000000001');
    expect(element().textContent).toContain('Revoked');
    expect(element().querySelector('.revoke-btn')).toBeNull();
  });

  it('offers a retry when the initial list request fails', async () => {
    const listServiceApiKeys = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('offline')))
      .mockReturnValueOnce(of([]));
    await setup({ listServiceApiKeys });
    fixture.detectChanges();

    expect(element().textContent).toContain('Could not load integration keys.');
    element().querySelector<HTMLButtonElement>('.retry-btn')!.click();
    fixture.detectChanges();

    expect(element().textContent).toContain('No SugarMaple integration keys yet.');
    expect(element().textContent).not.toContain('Could not load integration keys.');
  });
});
