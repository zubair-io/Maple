import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { By } from '@angular/platform-browser';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { AuthService, AuthUser } from './auth.service';
import { NativeHandoffConsentComponent } from './native-handoff-consent.component';

describe('NativeHandoffConsentComponent (#4673)', () => {
  const CHALLENGE = 'C'.repeat(43);
  const STATE = 'state-consent-1';
  const signedInUser: AuthUser = { id: 'u1', email: 'owner@maple.local', role: 'owner' };

  let fixture: ComponentFixture<NativeHandoffConsentComponent>;
  let auth: AuthService;
  let ctrl: HttpTestingController;
  let navigated: string[];

  function setup(url: string, user: AuthUser | null = signedInUser): void {
    window.history.replaceState({}, '', url);
    TestBed.configureTestingModule({
      imports: [NativeHandoffConsentComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    auth = TestBed.inject(AuthService);
    ctrl = TestBed.inject(HttpTestingController);
    navigated = [];
    (auth as unknown as { navigateTo: (u: string) => void }).navigateTo = (u) => navigated.push(u);
    auth.user.set(user);
    fixture = TestBed.createComponent(NativeHandoffConsentComponent);
    fixture.detectChanges();
  }

  afterEach(() => {
    vi.restoreAllMocks();
    ctrl.verify();
    window.history.replaceState({}, '', '/');
  });

  it('displays user, platform, and device and issues no code until the user clicks Approve', async () => {
    setup(
      `/?native_callback=maple-app&code_challenge=${CHALLENGE}&state=${STATE}&platform=Windows&device_label=Workstation`,
    );

    const dialog = fixture.nativeElement.querySelector('[data-testid="native-handoff-consent"]');
    expect(dialog).not.toBeNull();
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="native-handoff-user"]')
        ?.textContent?.trim(),
    ).toBe('owner@maple.local (owner)');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="native-handoff-platform"]')
        ?.textContent?.trim(),
    ).toBe('Windows');
    expect(
      fixture.nativeElement
        .querySelector('[data-testid="native-handoff-device"]')
        ?.textContent?.trim(),
    ).toBe('Workstation');

    // No code issued before clicking Approve.
    ctrl.expectNone('/api/auth/native-code');
    expect(navigated).toEqual([]);

    const approveBtn = fixture.nativeElement.querySelector(
      '[data-testid="native-handoff-approve"]',
    ) as HTMLButtonElement;
    approveBtn.click();

    const req = ctrl.expectOne('/api/auth/native-code');
    expect(req.request.body).toEqual({
      code_challenge: CHALLENGE,
      state: STATE,
      device_label: 'Workstation',
    });
    req.flush({ code: 'CODE-APPROVED' });
    await fixture.whenStable();
    fixture.detectChanges();

    const url = `maple-app://auth-success?code=CODE-APPROVED&state=${STATE}`;
    expect(navigated).toEqual([url]);
    const open = fixture.nativeElement.querySelector(
      '[data-testid="native-handoff-open"]',
    ) as HTMLButtonElement;
    expect(open.textContent).toContain('Open Maple');
    expect(
      (fixture.nativeElement.querySelector('[aria-label="Sign-in code"]') as HTMLInputElement)
        .value,
    ).toBe('CODE-APPROVED');
    open.click();
    expect(navigated).toEqual([url, url]);
    ctrl.expectNone('/api/auth/native-code');
    fixture.nativeElement.querySelector('[data-testid="native-handoff-cancel"]').click();
    fixture.detectChanges();
    expect(auth.nativeLaunchUrl()).toBeNull();
    expect(
      fixture.nativeElement.querySelector('[data-testid="native-handoff-consent"]'),
    ).toBeNull();
  });

  it('dismisses the consent modal and scrubs the URL without issuing a code when Cancel is clicked', () => {
    setup(`/?native_callback=maple-app&code_challenge=${CHALLENGE}&state=${STATE}`);
    expect(
      fixture.nativeElement.querySelector('[data-testid="native-handoff-consent"]'),
    ).not.toBeNull();

    const cancelBtn = fixture.nativeElement.querySelector(
      '[data-testid="native-handoff-cancel"]',
    ) as HTMLButtonElement;
    cancelBtn.click();
    fixture.detectChanges();

    ctrl.expectNone('/api/auth/native-code');
    expect(navigated).toEqual([]);
    expect(window.location.search).toBe('');
    expect(
      fixture.nativeElement.querySelector('[data-testid="native-handoff-consent"]'),
    ).toBeNull();
  });

  it('captures keyboard focus and attaches a focus trap while consent is visible', async () => {
    // jsdom has no layout; give visible modal content browser-like geometry.
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    setup(`/?native_callback=maple-app&code_challenge=${CHALLENGE}&state=${STATE}`);
    await fixture.whenStable();
    const trap = fixture.debugElement.query(By.directive(CdkTrapFocus)).injector.get(CdkTrapFocus);
    expect(trap.enabled).toBe(true);
    expect(trap.autoCapture).toBe(true);
    expect(trap.focusTrap.hasAttached()).toBe(true);
    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(CdkTrapFocus))).toBeNull();
    ctrl.expectNone('/api/auth/native-code');
  });

  it('does not render when the user is signed out', () => {
    setup(`/?native_callback=maple-app&code_challenge=${CHALLENGE}&state=${STATE}`, null);
    expect(
      fixture.nativeElement.querySelector('[data-testid="native-handoff-consent"]'),
    ).toBeNull();
  });
});
