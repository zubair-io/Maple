import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { API_BASE_URL, AuthService, type DeviceSession } from '@maple-common';
import { PairedDevicesComponent } from './paired-devices.component';

describe('PairedDevicesComponent', () => {
  let fixture: ComponentFixture<PairedDevicesComponent>;
  let http: HttpTestingController;

  const session = (overrides: Partial<DeviceSession> = {}): DeviceSession => ({
    id: 'dev-1',
    label: "Zubair's Apple TV",
    platform: 'tvos',
    created_at: '2026-07-01T00:00:00Z',
    last_used_at: '2026-07-17T00:00:00Z',
    ...overrides,
  });

  async function setup(authStub: Partial<AuthService>): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [PairedDevicesComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: AuthService, useValue: authStub },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PairedDevicesComponent);
    http = TestBed.inject(HttpTestingController);
  }

  afterEach(() => http.verify());
  // Always restore stubbed globals (confirm) even when an assertion throws
  // mid-test — a leaked stub would silently corrupt later cases.
  afterEach(() => vi.unstubAllGlobals());

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  it('renders one row per session from the service, showing the label', async () => {
    await setup({
      listDeviceSessions: () => of([session(), session({ id: 'dev-2', label: 'Living Room TV' })]),
    });
    fixture.detectChanges();

    const rows = el().querySelectorAll('.card-row');
    expect(rows.length).toBe(2);
    expect(el().textContent).toContain("Zubair's Apple TV");
    expect(el().textContent).toContain('Living Room TV');
    // The wire enum 'tvos' is normalized for display, never shown raw.
    expect(el().textContent).toContain('Apple TV ·');
    expect(el().textContent).not.toContain('tvos');
  });

  it('shows the empty-state copy when the list is empty', async () => {
    await setup({ listDeviceSessions: () => of([]) });
    fixture.detectChanges();

    expect(el().querySelectorAll('.card-row').length).toBe(0);
    expect(el().textContent).toContain('No paired devices');
  });

  it('clicking Revoke calls AuthService.revokeDeviceSession with the row id and removes the row on resolve', async () => {
    const revokeDeviceSession = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    await setup({
      listDeviceSessions: () => of([session()]),
      revokeDeviceSession,
    });
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('button')!.click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(revokeDeviceSession).toHaveBeenCalledWith('dev-1');
    expect(el().querySelectorAll('.card-row').length).toBe(0);
  });

  it('does not call the service when confirm() returns false', async () => {
    const revokeDeviceSession = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    await setup({
      listDeviceSessions: () => of([session()]),
      revokeDeviceSession,
    });
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('button')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(revokeDeviceSession).not.toHaveBeenCalled();
    expect(el().querySelectorAll('.card-row').length).toBe(1);
  });

  it('clears the revoke-failure banner once a later revoke succeeds', async () => {
    const revokeDeviceSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('step-up failed'))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    await setup({
      listDeviceSessions: () => of([session()]),
      revokeDeviceSession,
    });
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.delete-btn')!.click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(el().textContent).toContain('Revoke failed — try again.');
    expect(el().querySelectorAll('.card-row').length).toBe(1);

    el().querySelector<HTMLButtonElement>('.delete-btn')!.click();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(el().textContent).not.toContain('Revoke failed');
    expect(el().querySelectorAll('.card-row').length).toBe(0);
  });

  it('shows the error banner (not Loading) when the initial load fails, and Retry recovers', async () => {
    const listDeviceSessions = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('network down')))
      .mockReturnValueOnce(of([session()]));
    await setup({ listDeviceSessions });
    fixture.detectChanges();

    expect(el().textContent).toContain('Could not load paired devices.');
    expect(el().textContent).not.toContain('Loading');

    el().querySelector<HTMLButtonElement>('.btn-ghost')!.click();
    fixture.detectChanges();

    expect(el().querySelectorAll('.card-row').length).toBe(1);
    expect(el().textContent).toContain("Zubair's Apple TV");
    expect(el().textContent).not.toContain('Could not load paired devices.');
  });
});
