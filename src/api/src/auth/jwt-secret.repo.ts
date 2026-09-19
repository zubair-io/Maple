/**
 * DB-backed HS256 signing secret for access tokens — now read from SQLite
 * (#3787).
 *
 * The secret lives in `server_state` under the id `jwt_secret`, and the
 * get-or-create moved to `db/repos/server-state.repo.ts` with the same
 * name, signature and `created` semantics. It is still owned by the server
 * rather than configured through the environment, and it still exists to close
 * the two ways an auto-generated secret silently rotates and turns every
 * issued token into a `bad signature` 401:
 *
 *   1. Container recreate / redeploy — a file on the ephemeral layer is lost,
 *      the database file on its volume is not.
 *   2. Multiple instances — a per-process file gives each replica its own
 *      secret; the database gives them one.
 *
 * What the port changes is how concurrent boots converge: MongoDB's duplicate
 * key error became a conditional `INSERT … ON CONFLICT` whose row count says
 * which caller minted the secret. The on-disk fallback for an unreachable
 * database is unchanged and still lives in `./jwt-bootstrap.ts`.
 */

export { getOrCreateJwtSecret, JWT_SECRET_DOC_ID } from '../db/repos/server-state.repo.ts';
