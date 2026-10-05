import {
  callbackDestination,
  validateConnectionTicket,
  validatedAuthorizationUrl,
} from './connection.service';
import { captureConnectionFragment, takeConnectionFragment } from './connection-fragment';

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
function authUrl() {
  return (
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
    })
  );
}
function encoded(value: unknown) {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('Hosted Google connection boundary', () => {
  it('clears callback history before retaining a bounded fragment and consumes it once', () => {
    const replaceState = vi.fn();
    captureConnectionFragment(
      {
        pathname: '/connect/google-drive/return',
        hash: '#' + encoded({ ticket: 'signed.ticket', code: 'code' }),
        search: '?tracking=1',
      },
      { replaceState },
    );
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/connect/google-drive/return?ngsw-bypass=true',
    );
    expect(takeConnectionFragment()).toEqual({ ticket: 'signed.ticket', code: 'code' });
    expect(takeConnectionFragment()).toBeNull();
  });
  it('discards malformed, oversized and ambiguous code/error fragments after clearing history', () => {
    for (const hash of [
      '#invalid!',
      '#' + 'x'.repeat(16385),
      '#' + encoded({ ticket: 'signed.ticket', code: 'c', error: 'access_denied' }),
      '#' + encoded({ ticket: 'signed.ticket', code: 'code with space' }),
      '#' + encoded({ ticket: 'signed.ticket', code: 'c'.repeat(4097) }),
      '#' + encoded({ ticket: 'signed.ticket', error: 'AccessDenied' }),
      '#' + encoded({ ticket: 'missing-signature', code: 'code' }),
      '#' + encoded({ ticket: 'x'.repeat(4096) + '.proof', code: 'code' }),
      '#' + encoded({ ticket: 123, code: 'code' }),
      '#' + encoded([]),
      '#' + encoded(null),
    ]) {
      const replaceState = vi.fn();
      captureConnectionFragment(
        { pathname: '/connect/google-drive/return', hash, search: '' },
        { replaceState },
      );
      expect(replaceState).toHaveBeenCalled();
      expect(takeConnectionFragment()).toBeNull();
    }
  });
  it('clears history before decoding and retains only a bounded setup authorization URL', () => {
    const replaceState = vi.fn();
    const decode = globalThis.atob.bind(globalThis);
    const decodeSpy = vi.spyOn(globalThis, 'atob').mockImplementation((value) => {
      expect(replaceState).toHaveBeenCalledWith(null, '', '/connect/google-drive?ngsw-bypass=true');
      return decode(value);
    });
    try {
      captureConnectionFragment(
        {
          pathname: '/connect/google-drive',
          hash: '#' + encoded({ ticket: 'signed.ticket', authorizationUrl: authUrl() }),
          search: '',
        },
        { replaceState },
      );
      expect(takeConnectionFragment()).toEqual({
        ticket: 'signed.ticket',
        authorizationUrl: authUrl(),
      });
      captureConnectionFragment(
        {
          pathname: '/connect/google-drive',
          hash: '#' + encoded({ ticket: 'signed.ticket', authorizationUrl: 'x'.repeat(8193) }),
          search: '',
        },
        { replaceState },
      );
      expect(takeConnectionFragment()).toBeNull();
    } finally {
      decodeSpy.mockRestore();
    }
  });
  it('does not change editor navigation fragments', () => {
    const replaceState = vi.fn();
    captureConnectionFragment(
      { pathname: '/browse', hash: '#image', search: '' },
      { replaceState },
    );
    expect(replaceState).not.toHaveBeenCalled();
  });
  it('validates every Google authorization field against the signed metadata', () => {
    expect(
      validatedAuthorizationUrl({ ticket: 'signed.ticket', authorizationUrl: authUrl() }, ticket),
    ).toBe(authUrl());
    for (const mutation of [
      authUrl().replace('accounts.google.com', 'evil.test'),
      authUrl() + '&code_challenge=another',
      authUrl().replace('S256', 'plain'),
      authUrl() + '&login_hint=x',
    ]) {
      expect(() =>
        validatedAuthorizationUrl({ ticket: 'signed.ticket', authorizationUrl: mutation }, ticket),
      ).toThrow();
    }
  });
  it('rejects expired metadata and callback credentials, paths and cleartext remote origins', () => {
    expect(validateConnectionTicket(ticket)).toEqual(ticket);
    for (const changes of [
      { expiresAt: 0 },
      { expiresAt: Date.now() + 600001 },
      { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { expiresAt: 'tomorrow' },
      { nonce: 'n'.repeat(42) },
      { nonce: 123 },
      { challenge: 'c'.repeat(44) },
      { challenge: ' '.repeat(43) },
      { clientId: 'client.test' },
      { clientId: null },
      { version: 2 },
      { redirectUri: 'https://other.test/callback' },
      { returnUrl: ticket.returnUrl + '?query=1' },
      { returnUrl: ticket.returnUrl + '#fragment' },
      { returnUrl: 'https://' + 'a'.repeat(2049) },
      { returnUrl: 'http://photos.lan/api/cloud-backup/google/callback' },
      { returnUrl: 'https://user:pass@photos.lan/api/cloud-backup/google/callback' },
      { returnUrl: 'https://photos.lan/unrelated' },
      { scope: 'https://www.googleapis.com/auth/drive' },
    ]) {
      expect(() => validateConnectionTicket({ ...ticket, ...changes })).toThrow();
    }
  });
  it('preserves code and exact state on the fixed destination', () => {
    const url = new URL(callbackDestination({ ticket: 'signed.ticket', code: 'code' }, ticket));
    expect(url.origin).toBe('https://photos.lan:3443');
    expect(url.searchParams.get('state')).toBe('signed.ticket');
    expect(url.searchParams.get('code')).toBe('code');
  });
});
