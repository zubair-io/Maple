import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CloudBackupService, type GoogleBackupConfig } from '@maple-common';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleBackupComponent } from './google-backup.component';

const saved: GoogleBackupConfig = {
  clientMode: 'own',
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
      clientMode: 'own',
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
      clientMode: 'own',
      clientId: 'new.apps.googleusercontent.com',
      clientSecret: 'new-secret',
      callbackMode: 'relay',
    });
    expect(input('google-client-secret').value).toBe('');
  });
  it('saves the managed client without credentials and allows an actionable start failure', async () => {
    const managed = {
      ...saved,
      clientMode: 'maple' as const,
      clientId: '',
      clientSecretSet: false,
    };
    api.googleConfig.mockReturnValue(of(managed));
    api.saveGoogleConfig.mockReturnValue(of(managed));
    api.connectGoogle.mockReturnValue(
      throwError(() => new Error('Maple Google client is not configured.')),
    );
    await settle();
    expect(el().querySelector('#google-client-id')).toBeNull();
    expect(el().querySelector('#google-client-secret')).toBeNull();
    expect(el().querySelector('mui-select')).toBeNull();
    expect(input('google-maple-callback').value).toBe(saved.callbackUrl);
    expect(button('Save client settings').disabled).toBe(false);
    expect(button('Connect Google Drive').disabled).toBe(false);
    button('Save client settings').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientMode: 'maple',
      callbackMode: 'relay',
    });
    button('Connect Google Drive').click();
    await settle();
    expect(api.connectGoogle).toHaveBeenCalledWith('destination');
    expect(el().textContent).toContain('Maple Google client is not configured.');
  });
  it('passes the selected recovery root when starting Google consent', async () => {
    api.connectGoogle.mockReturnValue(throwError(() => new Error('Consent start test')));
    await settle();
    input('google-backup-root').value = 'recover-this-root';
    input('google-backup-root').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Connect Google Drive').click();
    await settle();
    expect(api.connectGoogle).toHaveBeenCalledWith('destination', 'recover-this-root');
  });
  it('clears typed secrets when switching modes and preserves the common callback URL', async () => {
    await settle();
    input('google-client-secret').value = 'never-send-to-managed';
    input('google-client-secret').dispatchEvent(new Event('input'));
    const checkbox = () => el().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox().click();
    await settle();
    expect(el().querySelector('#google-client-secret')).toBeNull();
    expect(input('google-maple-callback').value).toBe(saved.callbackUrl);
    checkbox().click();
    await settle();
    expect(input('google-client-secret').value).toBe('');
    expect(input('google-maple-callback').value).toBe(saved.callbackUrl);
    expect(el().textContent).toContain('renews directly with Google');
  });
  it('keeps an explicitly selected empty own client after clearing credentials', async () => {
    const empty = { ...saved, clientId: '', clientSecretSet: false };
    api.googleConfig.mockReturnValueOnce(of(saved)).mockReturnValue(of(empty));
    await settle();
    button('Clear Google credentials').click();
    await settle();
    expect(input('google-client-id').value).toBe('');
    expect(input('google-client-secret').value).toBe('');
    expect(button('Connect Google Drive').disabled).toBe(true);
  });
  it('seeds legacy owner-client settings when clientMode is absent', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, clientMode: undefined }));
    await settle();
    expect(input('google-client-id').value).toBe(saved.clientId);
  });
  it('does not allow starting OAuth until the central callback origin is configured', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, callbackUrl: null }));
    await settle();
    expect(button('Connect Google Drive').disabled).toBe(true);
    expect(el().textContent).toContain('Configure domain');
  });
  it('shows the same server callback with direct owner routing', async () => {
    api.googleConfig.mockReturnValue(
      of({ ...saved, callbackMode: 'direct', googleRedirectUri: saved.callbackUrl }),
    );
    await settle();
    expect(input('google-maple-callback').value).toBe(saved.callbackUrl);
    button('Save client settings').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientMode: 'own',
      clientId: saved.clientId,
      callbackMode: 'direct',
    });
  });
  it('shows only disconnect controls while connected, retaining recovery tools', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, connected: true, rootId: 'root' }));
    await settle();
    expect(button('Disconnect Google').disabled).toBe(false);
    expect(el().querySelector('#google-client-id')).toBeNull();
    expect(el().querySelector('#google-maple-callback')).toBeNull();
    expect(el().textContent).not.toContain('Connect Google Drive');
    expect(el().textContent).not.toContain('Clear Google credentials');
    button('Disconnect Google').click();
    await settle();
    expect(api.disconnectGoogle).toHaveBeenCalledWith('destination');
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
      clientMode: 'own',
      clientId: '',
      clientSecret: null,
      callbackMode: 'relay',
    });
  });
  it('attaches an existing root with the saved client while connected', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, connected: true }));
    await settle();
    input('google-backup-root').value = 'existing-root';
    input('google-backup-root').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    fixture.detectChanges();
    button('Verify existing backup').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientMode: 'own',
      clientId: saved.clientId,
      callbackMode: saved.callbackMode,
      rootId: 'existing-root',
    });
  });
  it('attaches an existing root using the saved managed mode', async () => {
    api.googleConfig.mockReturnValue(
      of({
        ...saved,
        clientMode: 'maple',
        connected: true,
        clientId: 'maple-client',
        clientSecretSet: false,
      }),
    );
    await settle();
    input('google-backup-root').value = 'existing-root';
    input('google-backup-root').dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button('Verify existing backup').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientMode: 'maple',
      callbackMode: 'relay',
      rootId: 'existing-root',
    });
  });
  it('preserves the client identity when clearing credentials of an attached backup', async () => {
    api.googleConfig.mockReturnValue(of({ ...saved, rootId: 'existing-root' }));
    await settle();
    button('Clear Google credentials').click();
    await settle();
    expect(api.saveGoogleConfig).toHaveBeenCalledWith('destination', {
      clientMode: 'own',
      clientId: saved.clientId,
      clientSecret: null,
      callbackMode: 'relay',
    });
  });
});
