/**
 * JWT secret bootstrap.
 *
 * The HS256 signing secret is resolved once at startup and published to
 * `process.env.MAPLE_JWT_SECRET`, which the auth middleware + routes read at
 * request time. The secret is NOT configured via the environment — it's owned
 * by the server. Resolution order:
 *   1. The database — collection `server_state`, document `_id: "jwt_secret"`,
 *      field `value`. Created once on first boot. This is the canonical store:
 *      Mongo data persists across container recreates and is shared by every
 *      instance, so the secret never silently rotates and tokens keep
 *      verifying. See `auth/jwt-secret.repo.ts`.
 *   2. On-disk file at MAPLE_JWT_SECRET_FILE — fallback ONLY when Mongo is
 *      unreachable at boot, so a degraded boot can still sign tokens.
 *   3. In-memory random secret — last resort when even the filesystem is
 *      unusable (read-only / no perms). Logged loudly; it won't survive a
 *      restart (every restart logs everyone out), so this is a red flag.
 *
 * Extracted from `index.ts` to keep that file under the 600-line budget;
 * behaviour is unchanged. `ensureJwtSecret()` is the single entry point called
 * from `start()`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { child as childLogger } from '../log.ts';
import { getOrCreateJwtSecret } from './jwt-secret.repo.ts';

const log = childLogger('server');

export async function ensureJwtSecret(): Promise<void> {
  const { secret, source } = await resolveJwtSecret();
  process.env.MAPLE_JWT_SECRET = secret;
  // Log a non-reversible fingerprint of the active secret. Every instance
  // that shares a secret prints the same fingerprint; if two replicas — or
  // the same server across a restart — show different fingerprints, that's
  // the smoking gun for "bad signature": a token signed by one secret is
  // being verified against another. `secretPrefix` is the first 3 characters
  // of the secret itself, so an operator can eyeball it against the stored
  // `server_state.jwt_secret` row without hashing anything. Deliberately
  // capped at 3: that exposes 18 of the secret's 256 entropy bits —
  // negligible — and the cap is load-bearing, so don't widen it.
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 12);
  const secretPrefix = secret.slice(0, 3);
  log.info({ source, fingerprint, secretPrefix }, 'JWT secret resolved');
}

type JwtSecretSource = 'db' | 'db-created' | 'file' | 'generated' | 'memory';

async function resolveJwtSecret(): Promise<{
  secret: string;
  source: JwtSecretSource;
}> {
  // 1. DB — canonical, shared across instances, survives recreates.
  try {
    const { secret, created } = await getOrCreateJwtSecret();
    if (created) {
      log.warn('minted a new JWT secret in the DB — first run, or the secret row was cleared');
    }
    return { secret, source: created ? 'db-created' : 'db' };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'could not read JWT secret from DB — falling back to MAPLE_JWT_SECRET_FILE',
    );
  }
  // 2/3. File fallback, then in-memory if the filesystem is unusable.
  return resolveJwtSecretFromFile();
}

/** File fallback for the JWT secret. Reads MAPLE_JWT_SECRET_FILE (default
 * `./.maple/jwt.secret`), generating + persisting it (mode 0o600) on first
 * use. Only reached when the DB is unreachable. Filesystem errors do NOT abort
 * boot — they degrade to an in-memory secret (which won't survive a restart),
 * since this path runs exactly when the server is already in a degraded state. */
function resolveJwtSecretFromFile(): {
  secret: string;
  source: JwtSecretSource;
} {
  const path = process.env.MAPLE_JWT_SECRET_FILE ?? './.maple/jwt.secret';
  try {
    if (existsSync(path)) {
      return { secret: readFileSync(path, 'utf8').trim(), source: 'file' };
    }
    mkdirSync(dirname(path), { recursive: true });
    const secret = randomBytes(32).toString('base64url');
    writeFileSync(path, secret, { mode: 0o600 });
    // Warn, not info: minting a new secret invalidates every access token issued
    // under the previous one (clients see "bad signature" 401s). Reaching here at
    // all means Mongo was unreachable; if it recurs every restart, fix Mongo
    // connectivity or point MAPLE_JWT_SECRET_FILE at persistent storage.
    log.warn({ path }, 'generated a NEW JWT secret on disk — existing sessions are now invalid');
    return { secret, source: 'generated' };
  } catch (err) {
    // Filesystem unusable (read-only mount, perms). Don't abort boot — degrade
    // to an in-memory secret so the server still runs. Loud, because it won't
    // survive a restart: every restart would then log everyone out.
    const secret = randomBytes(32).toString('base64url');
    log.warn(
      { path, err: err instanceof Error ? err.message : err },
      'could not read/write the JWT secret file — using an in-memory secret that will NOT survive a restart; fix Mongo connectivity or MAPLE_JWT_SECRET_FILE',
    );
    return { secret, source: 'memory' };
  }
}
