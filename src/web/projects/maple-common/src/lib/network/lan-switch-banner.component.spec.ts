import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { LanSwitchBannerComponent } from './lan-switch-banner.component';
import { LanSwitchService } from './lan-switch.service';

async function render(backend = 'self-hosted', signedIn = true) {
  const candidate = { origin: 'http://192.168.1.2:3000' };
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  const result = { promise, resolve };
  const service = {
    checkAvailable: vi.fn().mockResolvedValue(candidate),
    switchTo: vi.fn().mockReturnValue(result.promise),
  };
  TestBed.configureTestingModule({
    imports: [LanSwitchBannerComponent],
    providers: [
      { provide: AuthService, useValue: { isSignedIn: signedIn } },
      { provide: LIBRARY_BACKEND, useValue: backend },
      { provide: LanSwitchService, useValue: service },
    ],
  });
  const fixture = TestBed.createComponent(LanSwitchBannerComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const buttons = () =>
    Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
  return { fixture, buttons, service, candidate, result };
}

describe('LAN switch banner Maple UI actions', () => {
  it('keeps named native buttons, keyboard focus and the live status region', async () => {
    const { fixture, buttons } = await render();
    const [switchButton, dismissButton] = buttons();
    expect(fixture.nativeElement.querySelectorAll('mui-button')).toHaveLength(2);
    expect(switchButton.type).toBe('button');
    expect(switchButton.getAttribute('aria-label')).toBe('Switch to a local connection');
    expect(dismissButton.getAttribute('aria-label')).toBe('Dismiss');
    expect(switchButton.tabIndex).toBe(0);
    switchButton.focus();
    expect(document.activeElement).toBe(switchButton);
    dismissButton.focus();
    expect(document.activeElement).toBe(dismissButton);
    expect(fixture.nativeElement.querySelector('[role="status"]').getAttribute('aria-live')).toBe(
      'polite',
    );
    dismissButton.click();
    fixture.detectChanges();
    expect(buttons()).toHaveLength(0);
  });

  it('switches once, disables both actions while pending and hides a failed offer', async () => {
    const { fixture, buttons, service, candidate, result } = await render();
    const [switchButton, dismissButton] = buttons();
    switchButton.click();
    fixture.detectChanges();
    expect(service.switchTo).toHaveBeenCalledExactlyOnceWith(candidate);
    expect(switchButton.textContent).toContain('Switching…');
    expect(switchButton.disabled).toBe(true);
    expect(dismissButton.disabled).toBe(true);
    switchButton.click();
    dismissButton.click();
    expect(service.switchTo).toHaveBeenCalledTimes(1);
    expect(buttons()).toHaveLength(2);
    result.resolve(false);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(buttons()).toHaveLength(0);
  });

  it('does not offer a LAN switch on Hosted', async () => {
    const { buttons, service } = await render('hosted');
    expect(buttons()).toHaveLength(0);
    expect(service.checkAvailable).not.toHaveBeenCalled();
  });

  it('does not offer a LAN switch before sign-in', async () => {
    const { buttons, service } = await render('self-hosted', false);
    expect(buttons()).toHaveLength(0);
    expect(service.checkAvailable).not.toHaveBeenCalled();
  });
});
