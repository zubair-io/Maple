/** Persisted messages that a successful Drive probe proves are resolved. */
export const GOOGLE_CONNECTION_RECOVERY_ERRORS = {
  missingRefreshToken: 'Reconnect Google Drive to resume backup.',
  authorizationExpired: 'Authorization expired or revoked; reconnect Google Drive.',
  mapleAuthorizationChanged: 'Maple authorization changed; reconnect Google Drive.',
  unusableAccessToken: 'Google returned an unusable access token; reconnect Google Drive.',
  tokenVerificationFailed: 'Google token verification failed; reconnect Google Drive.',
  credentialsUnavailable: 'Drive credentials unavailable; reconnect Google Drive.',
  accountChanged: 'Google account changed; reconnect.',
  mapleAuthorizationUnavailable: 'Maple authorization is unavailable; reconnect Google Drive.',
  tokenRenewalInProgress: 'Google token renewal is already in progress; retry shortly.',
  domainChanged: 'Domain changed; reconnect Google Drive.',
  renewableGrantUnavailable:
    'Maple did not return a renewable authorization grant; reconnect Google Drive.',
} as const;

export const GOOGLE_CONNECTION_RECOVERY_ERROR_MESSAGES = Object.values(
  GOOGLE_CONNECTION_RECOVERY_ERRORS,
);
