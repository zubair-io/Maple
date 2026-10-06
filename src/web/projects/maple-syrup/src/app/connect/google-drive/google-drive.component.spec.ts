import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ConnectionService } from '../connection.service';
import { GoogleDriveComponent } from './google-drive.component';
import { captureConnectionFragment } from '../connection-fragment';

describe('GoogleDriveComponent', () => {
  it('shows standalone setup instructions without requesting any instance', async () => {
    captureConnectionFragment(
      { pathname: '/connect/google-drive', hash: '', search: '' },
      { replaceState: () => {} },
    );
    const validate = vi.fn(() => of(null));
    await TestBed.configureTestingModule({
      imports: [GoogleDriveComponent],
      providers: [{ provide: ConnectionService, useValue: { validate } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(GoogleDriveComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Settings → Backup');
    expect(validate).not.toHaveBeenCalled();
    expect(
      fixture.componentInstance.matchesCallback(
        'https://photos.lan/api/cloud-backup/google/callback',
      ),
    ).toBe(false);
    fixture.componentInstance.callback.set('https://photos.lan/api/cloud-backup/google/callback');
    expect(
      fixture.componentInstance.matchesCallback(
        'https://photos.lan/api/cloud-backup/google/callback',
      ),
    ).toBe(true);
  });
});

const ticket = {
  version: 1 as const,
  nonce: 'n'.repeat(43),
  clientId: '12345678-test.apps.googleusercontent.com',
  challenge: 'c'.repeat(43),
  returnUrl: 'https://photos.lan:3443/api/cloud-backup/google/callback',
  redirectUri: 'https://mapleeditor.com/api/connect/google-drive/callback',
  expiresAt: Date.now() + 60000,
  scope: 'https://www.googleapis.com/auth/drive.file',
};
const authorizationUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: ticket.clientId,
    redirect_uri: ticket.redirectUri,
    response_type: 'code',
    scope: ticket.scope,
    code_challenge: ticket.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state: 'signed.ticket',
  });
it('enables a labeled Continue only after the pasted callback matches signed metadata', async () => {
  captureConnectionFragment(
    {
      pathname: '/connect/google-drive',
      hash:
        '#' + btoa(JSON.stringify({ ticket: 'signed.ticket', authorizationUrl })).replace(/=/g, ''),
      search: '',
    },
    { replaceState: () => {} },
  );
  await TestBed.configureTestingModule({
    imports: [GoogleDriveComponent],
    providers: [{ provide: ConnectionService, useValue: { validate: () => of(ticket) } }],
  }).compileComponents();
  const fixture = TestBed.createComponent(GoogleDriveComponent);
  fixture.detectChanges();
  const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  expect(button.textContent).toContain('Continue to Google');
  expect(button.disabled).toBe(true);
  fixture.componentInstance.callback.set('https://wrong.lan/api/cloud-backup/google/callback');
  fixture.detectChanges();
  expect(button.disabled).toBe(true);
  fixture.componentInstance.callback.set(ticket.returnUrl);
  fixture.detectChanges();
  expect(button.disabled).toBe(false);
});

it.each([
  ['matching callback', 'https://photos.lan:3443/api/cloud-backup/google/callback', true],
  ['different callback', 'https://wrong.lan/api/cloud-backup/google/callback', false],
  ['missing callback', '', false],
])('automatically continues only for a signed request with %s', async (_, callback, automatic) => {
  const navigate = vi
    .spyOn(GoogleDriveComponent.prototype, 'continue')
    .mockImplementation(() => {});
  try {
    captureConnectionFragment(
      {
        pathname: '/connect/google-drive',
        hash:
          '#' +
          btoa(JSON.stringify({ ticket: 'signed.ticket', authorizationUrl })).replace(/=/g, ''),
        search: callback ? '?callback=' + encodeURIComponent(callback) : '',
      },
      { replaceState: vi.fn() },
    );
    await TestBed.configureTestingModule({
      imports: [GoogleDriveComponent],
      providers: [{ provide: ConnectionService, useValue: { validate: () => of(ticket) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(GoogleDriveComponent);
    fixture.detectChanges();
    expect(navigate).toHaveBeenCalledTimes(automatic ? 1 : 0);
    if (automatic) expect(navigate).toHaveBeenCalledWith(authorizationUrl);
  } finally {
    navigate.mockRestore();
  }
});
