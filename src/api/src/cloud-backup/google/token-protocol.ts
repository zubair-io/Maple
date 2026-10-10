import { GoogleConnectionError } from './config.ts';
import { GOOGLE_CONNECTION_RECOVERY_ERRORS as RECOVERY_ERROR } from './recovery-errors.ts';

export class GoogleReconnectRequired extends GoogleConnectionError {}

/** Only fixed error categories escape this boundary; provider bodies may contain secrets. */
export async function tokenResponse(response: Response, managed = false) {
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new GoogleConnectionError('Google token service returned an invalid response.');
  if (!response.ok) tokenFailure(body, managed);
  return parseTokens(body);
}
function tokenFailure(body: Record<string, unknown>, managed: boolean): never {
  if (body.error === 'invalid_grant')
    throw new GoogleReconnectRequired(RECOVERY_ERROR.authorizationExpired);
  if (body.error === 'invalid_client')
    throw new GoogleConnectionError(
      managed
        ? 'The Maple Google application is unavailable; retry Connect later.'
        : 'Check the Web Application Client ID and Client Secret.',
    );
  if (managed && body.error === 'invalid_proof')
    throw new GoogleReconnectRequired(RECOVERY_ERROR.mapleAuthorizationChanged);
  throw new GoogleConnectionError(
    'Google token request failed; check application permissions and retry Connect.',
  );
}
function optionalCredential(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 ? value : null;
}
function parseTokens(body: Record<string, unknown>) {
  if (
    !optionalCredential(body.access_token) ||
    typeof body.expires_in !== 'number' ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    body.token_type !== 'Bearer'
  )
    throw new GoogleConnectionError(RECOVERY_ERROR.unusableAccessToken);
  return {
    accessToken: body.access_token as string,
    expiresIn: body.expires_in,
    refreshToken: optionalCredential(body.refresh_token),
    relayGrant: optionalCredential(body.relayGrant),
  };
}
