/** Runtime-only managed LAN HTTPS settings (#3474). Secrets follow the
 * existing Cloudflare settings storage policy and never leave this module's
 * server-side callers. Certificate material is in a separate internal row. */
import { isIP } from 'node:net';
import { getDb } from '../db/client.ts';
import { SERVER_PORT } from '../runtime/server-port.ts';

export interface ManagedHttpsConfig {
  enabled: boolean;
  hostname: string;
  port: number;
  email: string;
  zone_id: string;
  api_token: string;
  http3: boolean;
  terms_agreed: boolean;
  revision: string;
}
export const DEFAULT_HTTPS: ManagedHttpsConfig = {
  enabled: false,
  hostname: '',
  port: 3443,
  email: '',
  zone_id: '',
  api_token: '',
  http3: true,
  terms_agreed: false,
  revision: '',
};

export function publicHttpsConfig(config: ManagedHttpsConfig) {
  const { api_token, revision: _revision, ...safe } = config;
  return { ...safe, api_token_set: api_token.length > 0 };
}

export function validateHttpsConfig(config: ManagedHttpsConfig): string | null {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    return 'HTTPS port must be an integer between 1 and 65535.';
  if (config.port === SERVER_PORT)
    return 'Managed HTTPS needs a different port from the IP/tunnel listener.';
  if (
    config.hostname &&
    (isIP(config.hostname) ||
      config.hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        config.hostname,
      ))
  )
    return 'Use a public DNS hostname without a scheme, path, wildcard or port.';
  if (config.zone_id && !/^[a-f0-9]{32}$/i.test(config.zone_id))
    return 'Cloudflare zone ID must contain 32 hexadecimal characters.';
  if (config.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email))
    return 'Enter a valid certificate contact email.';
  if (config.enabled && (!config.hostname || !config.email || !config.zone_id || !config.api_token))
    return 'Hostname, contact email, Cloudflare zone ID and API token are required.';
  if (config.enabled && !config.terms_agreed)
    return 'Accept the Let’s Encrypt subscriber agreement to enable automatic certificates.';
  return null;
}

export async function loadHttpsConfig(): Promise<ManagedHttpsConfig> {
  const db = await getDb();
  const doc = await db
    .collection<{ _id: string; config: ManagedHttpsConfig }>('app_settings')
    .findOne({ _id: 'managed_https' });
  return { ...DEFAULT_HTTPS, ...doc?.config };
}

export async function saveHttpsConfig(config: ManagedHttpsConfig): Promise<void> {
  const db = await getDb();
  await db
    .collection<{ _id: string; config: ManagedHttpsConfig }>('app_settings')
    .updateOne({ _id: 'managed_https' }, { $set: { config } }, { upsert: true });
}
