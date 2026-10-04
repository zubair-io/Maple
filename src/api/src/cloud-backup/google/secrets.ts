import { GoogleConnectionError } from './config.ts';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getOrCreateJwtSecret } from '../../auth/jwt-secret.repo.ts';

async function key() {
  const { secret } = await getOrCreateJwtSecret();
  return createHash('sha256')
    .update('maple/google-backup/credentials/v1\0')
    .update(secret)
    .digest();
}

/** Domain-separated AES-GCM; rotating the server key requires Drive reconnect.
 * Database/file permissions remain essential: the bootstrap key is server-owned. */
export async function seal(value: unknown, binding: string): Promise<string> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await key(), nonce);
  cipher.setAAD(Buffer.from(binding));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
}

export async function unseal<T>(value: string, binding: string): Promise<T> {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 29)
    throw new GoogleConnectionError('Drive credentials unavailable; reconnect Google Drive.');
  try {
    const cipher = createDecipheriv('aes-256-gcm', await key(), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(binding));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(),
    );
  } catch {
    throw new GoogleConnectionError('Drive credentials unavailable; reconnect Google Drive.');
  }
}
