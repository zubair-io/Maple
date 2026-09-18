/**
 * `app_settings` — the operator's DB-backed configuration.
 *
 * Every knob CLAUDE.md says belongs in the settings system rather than in an
 * environment variable lives in one MongoDB collection today, one document per
 * key: `cloudflare` (R2 account, bucket and credentials), `network`,
 * `performance`, `map`, `pano`, `render`, `observability`, `apns`, `migration`,
 * `missing-reaper`, `deduplicate`. The documents are `{ _id, config }`, read
 * whole by a repository module per key and never filtered into.
 *
 * It is a table rather than a gap because the alternative is an operator whose
 * cutover completes and whose install is then quietly misconfigured — R2
 * uploads failing because the credentials went missing, the map blank because
 * its tile configuration did. The whole document is stored so a key this server
 * version does not recognise survives too, which is the same reason `presets`
 * keeps an `extra` column.
 *
 * Shape follows the access pattern exactly: a string key, a JSON payload, one
 * primary-key lookup per read, and `WITHOUT ROWID` because the row IS the key
 * plus its payload. Nothing queries into the payload, so nothing here is a
 * generated column.
 */

export const APP_SETTINGS_TABLE_DDL = `
CREATE TABLE app_settings (
  -- Settings key, e.g. 'cloudflare' or 'missing-reaper'.
  id    TEXT NOT NULL PRIMARY KEY,
  -- The whole source document minus its key, stored verbatim.
  value TEXT NOT NULL CHECK (json_valid(value))
) WITHOUT ROWID;
`;
