// AccountComponent — identity + passkey list fetch on init, sign-out.
//
// AccountComponent embeds <maple-paired-devices>, which independently calls
// AuthService.listDeviceSessions() from ITS OWN constructor (fires before
// this component's ngOnInit even runs) — every AuthService stub below must
// supply it or that embedded component throws on creation.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import {
  API_BASE_URL,
  AuthService,
  LibraryStateService,
  StackPreferenceService,
  type AuthUser,
} from '@maple-common';
import { AccountComponent } from './account.component';

describe('AccountComponent', () => {
  let fixture: ComponentFixture<AccountComponent>;
  let component: AccountComponent;
  let http: HttpTestingController;
  const reloadListings = vi.fn();

  const owner: AuthUser = { id: 'u1', email: 'zubair@justmaple.app', role: 'owner' };

  async function setup(authOverrides: Partial<AuthService> = {}): Promise<void> {
    TestBed.resetTestingModule();
    reloadListings.mockClear();
    await TestBed.configureTestingModule({
      imports: [AccountComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LibraryStateService, useValue: { reloadListings } },
        {
          provide: AuthService,
          useValue: {
            user: signal<AuthUser | null>(owner),
            listDeviceSessions: () => of([]),
            addCredential: vi.fn().mockResolvedValue(undefined),
            deleteCredential: vi.fn().mockResolvedValue(undefined),
            signOut: vi.fn().mockResolvedValue(undefined),
            ...authOverrides,
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AccountComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    // Real Router.navigate would try to resolve '/sign-in' against an empty
    // route table; stub it so signOut()'s navigate doesn't reject the test.
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  }

  afterEach(() => http.verify());

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const toggleText = (testId: string): string =>
    el().querySelector<HTMLButtonElement>(`[data-testid="${testId}"] button`)!.textContent!.trim();

  /** Drive past ngOnInit's two GETs (credentials + display config). The two
   * requests are sequential (ngOnInit awaits the first before firing the
   * second), so a microtask tick has to elapse between the two flushes for
   * the `await this.refresh()` continuation to run. */
  async function initWithMock(
    credentials: {
      id: string;
      device_label: string;
      last_used_at: string | null;
      created_at: string;
    }[] = [],
  ): Promise<void> {
    fixture.detectChanges();
    http.expectOne('/api/auth/me').flush({ user: owner, credentials });
    await Promise.resolve();
    await Promise.resolve();
    http
      .expectOne('/api/display/config')
      .flush({ show_hidden_images: false, stack_raw_jpeg: true });
    fixture.detectChanges();
  }

  it('fetches identity + passkeys on init and renders them', async () => {
    await setup();
    await initWithMock([
      {
        id: 'c1',
        device_label: "Zubair's MacBook",
        last_used_at: '2026-08-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);

    expect(el().textContent).toContain('zubair@justmaple.app');
    expect(el().textContent).toContain('Owner');
    const rows = el().querySelectorAll('.card-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Zubair's MacBook");
  });

  it('shows the empty state when there are no passkeys', async () => {
    await setup();
    await initWithMock([]);
    expect(el().textContent).toContain('No passkeys registered.');
  });

  it('surfaces the error banner when the identity fetch fails', async () => {
    await setup();
    fixture.detectChanges();
    http
      .expectOne('/api/auth/me')
      .flush({ error: 'unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await Promise.resolve();
    await Promise.resolve();
    http
      .expectOne('/api/display/config')
      .flush({ show_hidden_images: false, stack_raw_jpeg: true });
    fixture.detectChanges();

    expect(el().querySelector('.error')?.textContent).toContain('unauthorized');
  });

  it('Add device calls AuthService.addCredential then re-fetches credentials', async () => {
    const addCredential = vi.fn().mockResolvedValue(undefined);
    await setup({ addCredential });
    await initWithMock([]);

    el().querySelector<HTMLButtonElement>('[data-testid="add-device-btn"] button')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(addCredential).toHaveBeenCalledWith('Web');
    http.expectOne('/api/auth/me').flush({
      user: owner,
      credentials: [
        {
          id: 'c2',
          device_label: 'iPad',
          last_used_at: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    // refresh()'s `await firstValueFrom(...)` then addDevice()'s `await
    // this.refresh()` — two chained awaits, two microtask hops.
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('iPad');
  });

  it('Delete calls AuthService.deleteCredential with the row id and re-fetches', async () => {
    const deleteCredential = vi.fn().mockResolvedValue(undefined);
    await setup({ deleteCredential });
    await initWithMock([
      {
        id: 'c1',
        device_label: "Zubair's MacBook",
        last_used_at: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ]);

    el().querySelector<HTMLButtonElement>('.delete-btn button')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteCredential).toHaveBeenCalledWith('c1');
    http.expectOne('/api/auth/me').flush({ user: owner, credentials: [] });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(el().textContent).toContain('No passkeys registered.');
  });

  it('Sign out calls AuthService.signOut and navigates to /sign-in', async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);
    await setup({ signOut });
    await initWithMock([]);

    el().querySelector<HTMLButtonElement>('[data-testid="sign-out-btn"] button')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(signOut).toHaveBeenCalledOnce();
    expect(TestBed.inject(Router).navigate).toHaveBeenCalledWith(['/sign-in']);
  });

  it('toggling Show Hidden Images PUTs the new value and flips the control on success', async () => {
    await setup();
    await initWithMock([]);
    expect(toggleText('show-hidden-toggle')).toBe('Off');

    el().querySelector<HTMLButtonElement>('[data-testid="show-hidden-toggle"] button')!.click();
    const req = http.expectOne('/api/display/config');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ show_hidden_images: true });
    req.flush({ ok: true });
    fixture.detectChanges();

    expect(toggleText('show-hidden-toggle')).toBe('On');
  });

  it('does not flip the toggle when the save reports ok:false', async () => {
    await setup();
    await initWithMock([]);

    el().querySelector<HTMLButtonElement>('[data-testid="show-hidden-toggle"] button')!.click();
    http.expectOne('/api/display/config').flush({ ok: false });
    fixture.detectChanges();

    expect(toggleText('show-hidden-toggle')).toBe('Off');
  });

  it('leaves showHidden at its default when the display-config fetch errors', async () => {
    await setup();
    fixture.detectChanges();
    http.expectOne('/api/auth/me').flush({ user: owner, credentials: [] });
    await Promise.resolve();
    await Promise.resolve();
    http
      .expectOne('/api/display/config')
      .flush({ error: 'not found' }, { status: 404, statusText: 'Not Found' });
    fixture.detectChanges();

    expect(toggleText('show-hidden-toggle')).toBe('Off');
    expect(toggleText('stack-raw-jpeg-toggle')).toBe('On');
  });

  it('shows the stored RAW+JPEG stacking choice', async () => {
    await setup();
    fixture.detectChanges();
    http.expectOne('/api/auth/me').flush({ user: owner, credentials: [] });
    await Promise.resolve();
    await Promise.resolve();
    http
      .expectOne('/api/display/config')
      .flush({ show_hidden_images: false, stack_raw_jpeg: false });
    fixture.detectChanges();

    expect(el().textContent).toContain('Show one image for RAW+JPEG pairs');
    expect(toggleText('stack-raw-jpeg-toggle')).toBe('Off');
  });

  it('toggling RAW+JPEG stacking PUTs only that field and reloads the listing on success', async () => {
    await setup();
    await initWithMock([]);
    expect(toggleText('stack-raw-jpeg-toggle')).toBe('On');

    el().querySelector<HTMLButtonElement>('[data-testid="stack-raw-jpeg-toggle"] button')!.click();
    const req = http.expectOne('/api/display/config');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ stack_raw_jpeg: false });
    expect(reloadListings).not.toHaveBeenCalled();
    req.flush({ ok: true });
    fixture.detectChanges();

    expect(toggleText('stack-raw-jpeg-toggle')).toBe('Off');
    expect(reloadListings).toHaveBeenCalledOnce();
    expect(await TestBed.inject(StackPreferenceService).load()).toBe(false);
  });

  it('keeps RAW+JPEG stacking and the listing when the save reports ok:false', async () => {
    await setup();
    await initWithMock([]);

    el().querySelector<HTMLButtonElement>('[data-testid="stack-raw-jpeg-toggle"] button')!.click();
    http.expectOne('/api/display/config').flush({ ok: false });
    fixture.detectChanges();

    expect(toggleText('stack-raw-jpeg-toggle')).toBe('On');
    expect(reloadListings).not.toHaveBeenCalled();
    expect(el().querySelector('[data-testid="preference-error"]')?.textContent).toContain(
      'Could not change "Show one image for RAW+JPEG pairs"',
    );
  });

  it('shows a failed stacking save instead of failing silently', async () => {
    await setup();
    await initWithMock([]);

    el().querySelector<HTMLButtonElement>('[data-testid="stack-raw-jpeg-toggle"] button')!.click();
    http
      .expectOne('/api/display/config')
      .flush({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();

    expect(toggleText('stack-raw-jpeg-toggle')).toBe('On');
    expect(el().querySelector('[role="alert"][data-testid="preference-error"]')).not.toBeNull();
  });

  it('shows stacking On when an older server omits stack_raw_jpeg', async () => {
    await setup();
    fixture.detectChanges();
    http.expectOne('/api/auth/me').flush({ user: owner, credentials: [] });
    await Promise.resolve();
    await Promise.resolve();
    http.expectOne('/api/display/config').flush({ show_hidden_images: false });
    fixture.detectChanges();

    expect(toggleText('stack-raw-jpeg-toggle')).toBe('On');
  });
});
