import { GoogleConnectionError, type GoogleConfig } from './config.ts';
import { managedClientId } from './managed.ts';
import type { GoogleFetch } from './oauth.ts';

export interface GoogleConfigPatch {
  clientMode?: GoogleConfig['clientMode'];
  clientId?: string;
  clientSecret?: string | null;
  callbackMode: GoogleConfig['callbackMode'];
  rootId?: string;
}
function validateClient(body: GoogleConfigPatch, current: GoogleConfig, clientId: string): void {
  if (clientId && !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId))
    throw new GoogleConnectionError('Enter a Google Web Application OAuth Client ID.');
  if (clientId && clientId !== current.clientId && !body.clientSecret?.trim())
    throw new GoogleConnectionError('A new Client ID requires its matching Client Secret.');
}
export async function configuredGoogleClient(
  body: GoogleConfigPatch,
  current: GoogleConfig,
  transport?: GoogleFetch,
) {
  const clientMode = body.clientMode ?? (body.clientId?.trim() ? 'own' : current.clientMode);
  const application =
    clientMode === 'maple'
      ? await managedApplication(body, transport)
      : ownApplication(body, current);
  const { clientId, clientSecret } = application;
  const callbackMode = clientMode === 'maple' ? 'relay' : body.callbackMode;
  const changed =
    clientMode !== current.clientMode ||
    clientId !== current.clientId ||
    clientSecret !== current.clientSecret ||
    callbackMode !== current.callbackMode;
  return {
    changed,
    config: {
      ...current,
      clientMode,
      clientId,
      clientSecret,
      callbackMode,
      ...(changed ? { refreshToken: null, relayGrant: null } : {}),
    },
  };
}

async function managedApplication(body: GoogleConfigPatch, transport?: GoogleFetch) {
  if (body.clientSecret?.trim())
    throw new GoogleConnectionError('The Maple client does not accept your Client Secret.');
  const clientId = await managedClientId(transport);
  if (body.clientId?.trim() && body.clientId.trim() !== clientId)
    throw new GoogleConnectionError('The Maple Google Client ID is managed by Maple.');
  return { clientId, clientSecret: '' };
}
function ownApplication(body: GoogleConfigPatch, current: GoogleConfig) {
  const clientId = (body.clientId ?? current.clientId).trim();
  validateClient(body, current, clientId);
  const clientSecret =
    body.clientSecret === null
      ? ''
      : body.clientSecret?.trim() || (current.clientMode === 'own' ? current.clientSecret : '');
  if ((!clientId || !clientSecret) && body.clientSecret !== null)
    throw new GoogleConnectionError(
      'Provide your Google Web Application Client ID and Client Secret.',
    );
  return { clientId, clientSecret };
}
