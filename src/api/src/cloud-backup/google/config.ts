import { isIP } from 'node:net';

export class GoogleConnectionError extends Error {}
/** The callback carries no live flow for this browser: its cookie is gone or the flow was spent. */
export class GoogleFlowUnavailable extends GoogleConnectionError {
  constructor() {
    super(
      'This Google sign-in link was already used or has expired. Your connection may already be complete; check its status below, or start Connect again.',
    );
  }
}

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_CALLBACK_PATH = '/api/cloud-backup/google/callback';
export const RELAY_ORIGIN = 'https://mapleeditor.com';
export const RELAY_CALLBACK = `${RELAY_ORIGIN}/api/connect/google-drive/callback`;
export const FLOW_COOKIE = 'maple_drive_flow';
export const FLOW_TTL = 10 * 60_000;

/** Why Maple discarded its renewal credentials; kept so the owner learns the real cause. */
export type GoogleDisconnectReason = 'invalid_grant' | 'invalid_proof' | 'missing_grant';
export interface GoogleDisconnect {
  reason: GoogleDisconnectReason;
  at: number;
}
export interface GoogleConfig {
  clientMode: 'maple' | 'own';
  clientId: string;
  clientSecret: string;
  callbackMode: 'direct' | 'relay';
  refreshToken: string | null;
  relayGrant: string | null;
  accountId: string | null;
  accountEmail: string | null;
  disconnect: GoogleDisconnect | null;
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
  disconnect: null,
};

const DISCONNECT_CAUSES: Record<GoogleDisconnectReason, string> = {
  invalid_grant: "Google expired or revoked Maple's Drive authorization",
  invalid_proof: "The Maple token service rejected this server's renewal grant",
  missing_grant: 'The saved Maple renewal grant was missing',
};
export function reconnectMessage(disconnect: GoogleDisconnect | null): string {
  if (!disconnect) return 'Reconnect Google Drive to resume backup.';
  const at = new Date(disconnect.at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${DISCONNECT_CAUSES[disconnect.reason]} (${disconnect.reason}) at ${at}. Reconnect Google Drive to resume backup.`;
}
/** A recorded cause survives every later credential drop; only a successful reconnect clears it. */
export function withoutCredentials(
  config: GoogleConfig,
  disconnect: GoogleDisconnect | null = config.disconnect,
): GoogleConfig {
  return { ...config, refreshToken: null, relayGrant: null, disconnect };
}

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

function publicDisconnect(disconnect: GoogleDisconnect | null) {
  return disconnect
    ? {
        reason: disconnect.reason,
        at: new Date(disconnect.at).toISOString(),
        message: reconnectMessage(disconnect),
      }
    : null;
}
/** The non-secret connection state the destination list shows without opening the panel. */
export function connectionState(config: GoogleConfig) {
  return { connected: !!config.refreshToken, disconnect: publicDisconnect(config.disconnect) };
}
export function validDisconnect(value: unknown): GoogleDisconnect | null {
  if (!value || typeof value !== 'object') return null;
  const { reason, at } = value as Partial<GoogleDisconnect>;
  return typeof reason === 'string' &&
    Object.hasOwn(DISCONNECT_CAUSES, reason) &&
    typeof at === 'number' &&
    Number.isFinite(new Date(at).getTime())
    ? { reason, at }
    : null;
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
    disconnect: publicDisconnect(config.disconnect),
    callbackUrl: callback,
    googleRedirectUri: config.callbackMode === 'relay' ? RELAY_CALLBACK : callback,
    mapleClientAvailable: true,
  };
}
