import { GoogleConnectionError, type GoogleConfig } from './config.ts';

export interface GoogleConfigPatch {
  clientId: string;
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
export function configuredGoogleClient(body: GoogleConfigPatch, current: GoogleConfig) {
  const clientId = body.clientId.trim();
  validateClient(body, current, clientId);
  const clientSecret =
    body.clientSecret === null ? '' : body.clientSecret?.trim() || current.clientSecret;
  const changed =
    clientId !== current.clientId ||
    clientSecret !== current.clientSecret ||
    body.callbackMode !== current.callbackMode;
  return {
    changed,
    config: {
      ...current,
      clientId,
      clientSecret,
      callbackMode: body.callbackMode,
      ...(changed ? { refreshToken: null } : {}),
    },
  };
}
