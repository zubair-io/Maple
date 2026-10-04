import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CloudBackupService, type GoogleBackupConfig } from '@maple-common';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleBackupComponent } from './google-backup.component';

const saved: GoogleBackupConfig = {
  clientId: 'owner.apps.googleusercontent.com',
  clientSecretSet: true,
  callbackMode: 'relay',
  connected: false,
  accountId: null,
  accountEmail: null,
  rootId: null,
  callbackUrl: 'https://photos.example.com/api/cloud-backup/google/callback',
  googleRedirectUri: 'https://mapleeditor.com/api/connect/google-drive/callback',
  mapleClientAvailable: false,
};

describe('GoogleBackupComponent', () => {
  let fixture: ComponentFixture<GoogleBackupComponent>;
  const api = {
    googleConfig: vi.fn(),
    saveGoogleConfig: vi.fn(),
    connectGoogle: vi.fn(),
    disconnectGoogle: vi.fn(),
    createGoogleRoot: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    api.googleConfig.mockReturnValue(of(saved));
    api.saveGoogleConfig.mockReturnValue(of(saved));
    api.disconnectGoogle.mockReturnValue(of({ ok: true }));
    api.createGoogleRoot.mockReturnValue(of({ ...saved, rootId: 'root' }));
    await TestBed.configureTestingModule({
      imports: [GoogleBackupComponent],
      providers: [provideRouter([]), { provide: CloudBackupService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(GoogleBackupComponent);
    fixture.componentRef.setInput('destinationId', 'destination');
  });
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const el = (): HTMLElement => fixture.nativeElement;
  function button(label: string): HTMLButtonElement {
    const element = Array.from(el().querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === label,
    );
    if (!element) throw new Error(`missing button ${label}`);
    return element;
  }
  function input(id: string): HTMLInputElement {
    const element = el().querySelector<HTMLInputElement>(`#${id}`);
    if (!element) throw new Error(`missing input ${id}`);
    return element;
  }
  it('shows saved credentials without returning a secret and omits unchanged secret on save', async () => {
    await settle();
    expect(input('google-client-secret').value).toBe('');
    expect(input('google-client-secret').type).toBe('password');
    expect(input('google-maple-callback').value).toBe(saved.callbackUrl);
    button('Save client settings').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientId: saved.clientId,
      callbackMode: 'relay',
    });
  });
  it('requires a matching new secret when the client ID changes', async () => {
    await settle();
    input('google-client-id').value = 'new.apps.googleusercontent.com';
    input('google-client-id').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button('Connect Google Drive').disabled).toBe(true);
    input('google-client-secret').value = 'new-secret';
    input('google-client-secret').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button('Connect Google Drive').disabled).toBe(false);
    button('Save client settings').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientId: 'new.apps.googleusercontent.com',
      clientSecret: 'new-secret',
      callbackMode: 'relay',
    });
    expect(input('google-client-secret').value).toBe('');
  });
  it('keeps Maple-provided connect unavailable when no owner client exists', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, clientId: '', clientSecretSet: false }));
    await settle();
    expect(el().textContent).toContain('Maple-provided client is unavailable');
    expect(el().querySelector('#google-client-id')).toBeNull();
    expect(api.connectGoogle).not.toHaveBeenCalled();
  });
  it('does not allow starting OAuth until the central callback origin is configured', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, callbackUrl: null }));
    await settle();
    expect(button('Connect Google Drive').disabled).toBe(true);
    expect(el().textContent).toContain('Configure domain');
  });
  it('creates backup root only on explicit action after connecting', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, connected: true }));
    await settle();
    expect(api.createGoogleRoot).not.toHaveBeenCalled();
    button('Create backup folder').click();
    await settle();
    expect(api.createGoogleRoot).toHaveBeenCalledWith('destination');
  });
  it('explicit clear disconnects before clearing stored client credentials', async () => {
    await settle();
    button('Clear Google credentials').click();
    await settle();
    expect(api.disconnectGoogle).toHaveBeenCalledWith('destination');
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientId: '',
      clientSecret: null,
      callbackMode: 'relay',
    });
  });
  it('attaches an existing root with saved credentials without applying unsaved form changes', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, connected: true }));
    await settle();
    input('google-client-id').value = 'unsaved.apps.googleusercontent.com';
    input('google-client-id').dispatchEvent(new Event('input'));
    input('google-backup-root').value = 'existing-root';
    input('google-backup-root').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Verify existing backup').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientId: saved.clientId,
      callbackMode: saved.callbackMode,
      rootId: 'existing-root',
    });
  });
});
