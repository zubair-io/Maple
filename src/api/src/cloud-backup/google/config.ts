import { isIP } from 'node:net';

export class GoogleConnectionError extends Error {}

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_CALLBACK_PATH = '/api/cloud-backup/google/callback';
export const RELAY_ORIGIN = 'https://mapleeditor.com';
export const RELAY_CALLBACK = `${RELAY_ORIGIN}/api/connect/google-drive/callback`;
export const FLOW_COOKIE = 'maple_drive_flow';
export const FLOW_TTL = 10 * 60_000;

export interface GoogleConfig {
  clientMode: 'maple' | 'own';
  clientId: string;
  clientSecret: string;
  callbackMode: 'direct' | 'relay';
  refreshToken: string | null;
  relayGrant: string | null;
  accountId: string | null;
  accountEmail: string | null;
}
export const DEFAULT_GOOGLE_CONFIG: GoogleConfig = {
  clientMode: 'maple',
  clientId: '',
  clientSecret: '',
  callbackMode: 'relay',
  refreshToken: null,
  relayGrant: null,
  accountId: null,
  accountEmail: null,
};

/** Never infer the origin from Host/Forwarded headers. HTTP is loopback only. */
export function callbackUrl(origin: string): string {
  const url = new URL(origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new GoogleConnectionError(
      'Configure a browser-reachable HTTPS domain, or browser-local loopback origin.',
    );
  }
  return `${url.origin}${GOOGLE_CALLBACK_PATH}`;
}

export function validateDirectCallback(callback: string): void {
  const url = new URL(callback);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !loopback &&
    (isIP(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.local'))
  ) {
    throw new GoogleConnectionError(
      'Google direct callbacks need a qualifying HTTPS DNS domain or localhost.',
    );
  }
}

export function publicConfig(config: GoogleConfig, callback: string | null) {
  return {
    clientMode: config.clientMode,
    clientId: config.clientId,
    clientSecretSet: config.clientMode === 'own' && !!config.clientSecret,
    callbackMode: config.callbackMode,
    connected: !!config.refreshToken,
    accountId: config.accountId,
    accountEmail: config.accountEmail,
    callbackUrl: callback,
    googleRedirectUri: config.callbackMode === 'relay' ? RELAY_CALLBACK : callback,
    mapleClientAvailable: true,
  };
}
