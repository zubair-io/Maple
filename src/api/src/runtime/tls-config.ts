/**
 * Optional TLS bootstrap for the self-hosted HTTP server (#2415).
 *
 * On a LAN, Chrome's secure-context requirement (`navigator.gpu`, WebAuthn)
 * means a plain-http `http://<lan-ip>:3000` origin can never expose WebGPU —
 * the editor's live GPU render path silently falls back to the slower
 * WASM-CPU/2D path. Setting `MAPLE_TLS_CERT` + `MAPLE_TLS_KEY` (absolute
 * paths to a certificate and private key — e.g. from `mkcert`, see
 * `src/api/README.md` § "TLS on the LAN") switches the server to HTTPS,
 * which restores the secure context on the LAN origin too.
 *
 * Env vars are the right config surface here (not a DB-backed setting) —
 * this is pre-DB infra bootstrap: the credentials to listen with must be
 * known before the process can accept ANY connection, DB-backed or not (see
 * CLAUDE.md "Configure via the settings system, not new env vars").
 *
 * Resolved once at module load (mirrors `server-port.ts`'s `SERVER_PORT`
 * singleton) so `index.ts` and `routes/network.ts` see the identical,
 * already-validated config without re-deriving it. Fails FAST (throws) on a
 * half-configured pair or an unreadable file rather than silently falling
 * back to plain HTTP — a silent fallback here would boot looking healthy
 * while quietly continuing to serve the exact insecure origin #2415 exists
 * to fix.
 */

// Raw node:fs is allowlisted in .oxlintrc.json for this file: read-only
// bootstrap access to operator-provided cert/key paths — nothing durable is
// written, so the mirrored-fs layer doesn't apply.
import { accessSync, constants, readFileSync } from 'node:fs';

export interface TlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Pure resolver — exported for tests. Reads `MAPLE_TLS_CERT` / `MAPLE_TLS_KEY`
 * from the given env map (defaults to `process.env`).
 *
 * - Both unset → returns `null` (plain HTTP, today's behavior).
 * - Both set + both readable → returns the validated paths.
 * - Exactly one set, or a set path that isn't a readable file → throws with
 *   a message naming the offending var, so a misconfigured deploy fails at
 *   startup instead of quietly serving HTTP.
 */
export function resolveTlsConfig(env: NodeJS.ProcessEnv = process.env): TlsConfig | null {
  const cert = trimmedOrUndefined(env.MAPLE_TLS_CERT);
  const key = trimmedOrUndefined(env.MAPLE_TLS_KEY);

  if (!cert && !key) return null;
  if (!cert || !key) {
    throw new Error(
      'MAPLE_TLS_CERT and MAPLE_TLS_KEY must both be set to enable TLS ' +
        `(got MAPLE_TLS_CERT=${cert ? 'set' : 'unset'}, MAPLE_TLS_KEY=${key ? 'set' : 'unset'}). ` +
        'Unset both to keep serving plain HTTP, or set both to the absolute paths of a ' +
        'certificate and private key.',
    );
  }

  for (const [name, path] of [
    ['MAPLE_TLS_CERT', cert],
    ['MAPLE_TLS_KEY', key],
  ] as const) {
    try {
      accessSync(path, constants.R_OK);
    } catch (err) {
      throw new Error(
        `${name}=${path} is not a readable file (${(err as Error).message}). ` +
          'Check the path is absolute and the process has read access.',
        { cause: err },
      );
    }
  }

  return { certPath: cert, keyPath: key };
}

/** Singleton, resolved once at process start — see file header. Throws
 * synchronously on import if TLS is half-configured or unreadable.
 * Module-private: consumers read `TLS_ENABLED` / call `listenOptions()`. */
const TLS_CONFIG = resolveTlsConfig();

/** Whether the server is (about to be) listening over TLS. Read by
 * `routes/network.ts` so the advertised LAN scheme matches reality. */
export const TLS_ENABLED = TLS_CONFIG !== null;

/** `Elysia#listen()` options for `port`: a bare port when TLS is unconfigured,
 * or Bun.serve's `{ port, tls }` shape when it is. Lives here (not index.ts)
 * so the pass-through logic sits next to the config singleton it reads. */
export function listenOptions(
  port: number,
): number | { port: number; tls: { cert: Buffer; key: Buffer } } {
  if (TLS_CONFIG === null) return port;
  return {
    port,
    tls: {
      cert: readFileSync(TLS_CONFIG.certPath),
      key: readFileSync(TLS_CONFIG.keyPath),
    },
  };
}
