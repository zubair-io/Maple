// UsersComponent — member list render, invite-code issue and rescind
// requests.
//
// UsersComponent talks to the server exclusively through AuthService methods
// that are individually step-up (WebAuthn) gated — createInvite/rescindInvite
// call `stepUp()` internally, which drives `startAuthentication()` and would
// need a real passkey ceremony. Following the paired-devices.component.spec.ts
// house pattern, AuthService is stubbed as a Partial rather than exercised
// through HttpTestingController.
//
// The invite-form's `email` field is bound with plain `<form>` + `[(ngModel)]`
// (template-driven forms, no `[formGroup]`). Angular's `NgForm.addControl`
// wires up the real value accessor (`registerOnChange`, etc.) via a
// `resolvedPromise.then(...)` microtask, not synchronously — so a test has to
// let one microtask tick pass after the form first renders before dispatching
// an `input` event, or the control's `onChange` is still the accessor's
// no-op default and the typed value never reaches the component.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { signal } from '@angular/core';
import { AuthService, type AuthUser } from '@maple-common';
import { UsersComponent } from './users.component';

describe('UsersComponent', () => {
  let fixture: ComponentFixture<UsersComponent>;
  let http: HttpTestingController;

  const owner: AuthUser = { id: 'u1', email: 'zubair@justmaple.app', role: 'owner' };

  const invite = (overrides: Partial<Record<string, unknown>> = {}) => ({
    code: 'ABC123',
    email: 'new@justmaple.app',
    expires_at: '2026-09-01T00:00:00Z',
    consumed_at: null,
    ...overrides,
  });

  async function setup(authOverrides: Partial<AuthService> = {}): Promise<void> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [UsersComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            user: signal<AuthUser | null>(owner),
            listInvites: vi.fn().mockResolvedValue([]),
            ...authOverrides,
          },
        },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(UsersComponent);
  }

  // Every user/invite call in this component goes through the stubbed
  // AuthService, so the expectation is genuinely zero HttpClient traffic.
  // Verifying it (rather than just providing the testing backend) is what
  // makes that a real assertion: if the component later grows a direct
  // HttpClient dependency, or a request leaks unflushed, these tests fail
  // instead of silently passing. Matches the other specs in this directory.
  afterEach(() => {
    http.verify();
  });

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  /** Drain a chain of `await`s several microtask hops deep — e.g.
   * `createInvite()` chains `await auth.createInvite()` → `await
   * this.refresh()` → `await auth.listInvites()`, each its own hop. */
  async function settle(hops = 6): Promise<void> {
    for (let i = 0; i < hops; i++) await Promise.resolve();
  }

  /** Open the invite form and type an email into it. */
  async function openFormAndTypeEmail(email: string): Promise<void> {
    el().querySelector<HTMLButtonElement>('.btn-primary')!.click();
    fixture.detectChanges();
    // Let NgForm's addControl microtask wire up the real value accessor
    // (see file header) before dispatching input.
    await Promise.resolve();

    const emailInput = el().querySelector<HTMLInputElement>('input[type="email"]')!;
    emailInput.value = email;
    emailInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  it('renders the signed-in user as the sole member row', async () => {
    await setup();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const rows = el().querySelectorAll('.member-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('zubair@justmaple.app');
    expect(rows[0].textContent).toContain('YOU');
    expect(rows[0].textContent).toContain('OWNER');
  });

  it('renders one invite-row per pending invite from listInvites()', async () => {
    const listInvites = vi
      .fn()
      .mockResolvedValue([invite(), invite({ code: 'DEF456', email: 'b@justmaple.app' })]);
    await setup({ listInvites });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const rows = el().querySelectorAll('.invite-row');
    expect(rows.length).toBe(2);
    expect(el().textContent).toContain('new@justmaple.app');
    expect(el().textContent).toContain('DEF456');
  });

  it('shows the empty state when there are no invites', async () => {
    await setup();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    expect(el().textContent).toContain('No pending invites.');
  });

  it('shows a consumed invite without a Revoke button', async () => {
    const listInvites = vi
      .fn()
      .mockResolvedValue([invite({ consumed_at: '2026-08-01T00:00:00Z' })]);
    await setup({ listInvites });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const row = el().querySelector('.invite-row')!;
    expect(row.classList.contains('is-consumed')).toBe(true);
    expect(row.textContent).toContain('consumed');
    expect(row.querySelector('.revoke-btn')).toBeNull();
  });

  it('Invite user opens the form; submitting calls createInvite and shows the fresh-invite card', async () => {
    const createInvite = vi
      .fn()
      .mockResolvedValue({ code: 'NEWCODE', expires_at: '2026-09-01T00:00:00Z' });
    const listInvites = vi.fn().mockResolvedValue([]);
    await setup({ createInvite, listInvites });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    await openFormAndTypeEmail('new@justmaple.app');
    expect(el().querySelector('.invite-form')).toBeTruthy();

    el().querySelector<HTMLButtonElement>('.invite-form button[type="submit"]')!.click();
    await settle();
    fixture.detectChanges();

    expect(createInvite).toHaveBeenCalledWith('new@justmaple.app');
    expect(el().querySelector('.invite-form')).toBeNull(); // form closes on success
    const fresh = el().querySelector('.fresh-invite')!;
    expect(fresh).toBeTruthy();
    expect(fresh.textContent).toContain('NEWCODE');
    expect(listInvites).toHaveBeenCalledTimes(2); // ngOnInit + post-create refresh
  });

  it('surfaces the error banner when createInvite rejects', async () => {
    const createInvite = vi.fn().mockRejectedValue(new Error('step-up required'));
    await setup({ createInvite });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    await openFormAndTypeEmail('x@justmaple.app');
    el().querySelector<HTMLButtonElement>('.invite-form button[type="submit"]')!.click();
    await settle();
    fixture.detectChanges();

    expect(el().querySelector('.error')?.textContent).toContain('step-up required');
  });

  it('Revoke calls rescindInvite with the row code and refreshes the list', async () => {
    const rescindInvite = vi.fn().mockResolvedValue(undefined);
    const listInvites = vi.fn().mockResolvedValueOnce([invite()]).mockResolvedValueOnce([]);
    await setup({ rescindInvite, listInvites });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.revoke-btn')!.click();
    await settle();
    fixture.detectChanges();

    expect(rescindInvite).toHaveBeenCalledWith('ABC123');
    expect(el().querySelectorAll('.invite-row').length).toBe(0);
  });

  it('clears the fresh-invite card when the just-issued invite is rescinded', async () => {
    const createInvite = vi
      .fn()
      .mockResolvedValue({ code: 'NEWCODE', expires_at: '2026-09-01T00:00:00Z' });
    const rescindInvite = vi.fn().mockResolvedValue(undefined);
    const listInvites = vi
      .fn()
      .mockResolvedValueOnce([]) // ngOnInit
      .mockResolvedValueOnce([invite({ code: 'NEWCODE' })]) // after createInvite
      .mockResolvedValueOnce([]); // after rescind
    await setup({ createInvite, rescindInvite, listInvites });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    await openFormAndTypeEmail('new@justmaple.app');
    el().querySelector<HTMLButtonElement>('.invite-form button[type="submit"]')!.click();
    await settle();
    fixture.detectChanges();
    expect(el().querySelector('.fresh-invite')).toBeTruthy();

    el().querySelector<HTMLButtonElement>('.revoke-btn')!.click();
    await settle();
    fixture.detectChanges();

    expect(rescindInvite).toHaveBeenCalledWith('NEWCODE');
    expect(el().querySelector('.fresh-invite')).toBeNull();
  });
});
