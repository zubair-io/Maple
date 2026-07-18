import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of } from 'rxjs';
import { API_BASE_URL, AuthService, type DeviceSession } from '@maple-common';
import { PairedDevicesComponent } from './paired-devices.component';

describe('PairedDevicesComponent', () => {
  let fixture: ComponentFixture<PairedDevicesComponent>;
  let http: HttpTestingController;

  const session = (overrides: Partial<DeviceSession> = {}): DeviceSession => ({
    id: 'dev-1',
    label: "Zubair's Apple TV",
    platform: 'tvOS',
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
    vi.unstubAllGlobals();
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
    vi.unstubAllGlobals();
  });
});
