import { DRIVE_SCOPE, RELAY_CALLBACK, RELAY_ORIGIN, GoogleConnectionError } from './config.ts';
import type { GoogleFetch } from './oauth.ts';
import { tokenResponse } from './token-protocol.ts';
import { GOOGLE_CONNECTION_RECOVERY_ERRORS as RECOVERY_ERROR } from './recovery-errors.ts';

const managedEndpoint = `${RELAY_ORIGIN}/api/connect/google-drive`;
/** The shared secret remains at this fixed Maple service; only transient tokens cross it. */
export async function managedClientId(transport: GoogleFetch = fetch): Promise<string> {
  const response = await transport(`${managedEndpoint}/config`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new GoogleConnectionError(
      'The Maple Google application is unavailable; retry Connect later.',
    );
  });
  const metadata = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || metadata?.available !== true)
    throw new GoogleConnectionError(
      'The Maple Google application is unavailable; retry Connect later.',
    );
  if (
    metadata.scope !== DRIVE_SCOPE ||
    metadata.redirectUri !== RELAY_CALLBACK ||
    typeof metadata.clientId !== 'string' ||
    !/^[A-Za-z0-9._-]{8,200}\.apps\.googleusercontent\.com$/.test(metadata.clientId)
  )
    throw new GoogleConnectionError('The Maple Google application returned invalid configuration.');
  return metadata.clientId;
}

export async function managedTokens(
  operation: 'exchange' | 'refresh',
  payload:
    | { ticket: string; code: string; verifier: string }
    | { refreshToken: string; relayGrant: string },
  transport: GoogleFetch,
) {
  const response = await transport(`${managedEndpoint}/${operation}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    throw new GoogleConnectionError(
      'The Maple Google token service is unavailable; retry shortly.',
    );
  });
  const tokens = await tokenResponse(response, true);
  if (!tokens.relayGrant)
    throw new GoogleConnectionError(
      RECOVERY_ERROR.renewableGrantUnavailable,
    );
  return tokens;
}
