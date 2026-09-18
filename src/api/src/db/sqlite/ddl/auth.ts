/**
 * Authentication tables: users, passkeys, invites, refresh tokens, service API
 * keys, and the four short-lived single-use code tables.
 *
 * ## The one behavioural change in this file
 *
 * Six of these collections rely on a MongoDB TTL index to delete expired rows
 * (`invites`, `refresh_tokens`, `challenges`, `native_auth_codes`,
 * `lan_handoff_codes`, and `image_access_tokens`). SQLite has no TTL monitor,
 * so expiry becomes an explicit periodic `DELETE … WHERE expires_at < ?` and
 * each table carries an index on `expires_at` to make that sweep a range scan
 * rather than a table scan.
 *
 * This is a real semantic difference and it matters for security review, so it
 * is stated rather than buried: every one of these tables already had to treat
 * expiry as a read-time check, because Mongo's TTL monitor only runs once a
 * minute and an expired document is fully readable until it fires. Nothing here
 * gets less safe; the garbage collection just becomes ours.
 *
 * `expires_at` is stored as an ISO 8601 string, like every other timestamp in
 * the schema. ISO 8601 in UTC sorts lexically, so a string comparison is a
 * correct range scan.
 */

export const USERS_TABLE_DDL = `
CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  email TEXT NOT NULL,
  role  TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  -- Per-user file-access permission (#2893). NULL means "not set", which reads
  -- as true; owners have file access regardless.
  file_access INTEGER CHECK (file_access IS NULL OR file_access IN (0, 1)),

  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
`;

export const USERS_INDEX_DDL = `
-- Case-insensitive uniqueness, matching the Mongo collation
-- { locale: 'en', strength: 2 } on the same field.
CREATE UNIQUE INDEX users_email_unique ON users (email COLLATE NOCASE);
`;

/** One user, many passkeys. `public_key` is a COSE key, stored as a blob. */
export const CREDENTIALS_TABLE_DDL = `
CREATE TABLE credentials (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT CHECK (transports IS NULL OR json_valid(transports)),
  device_label  TEXT NOT NULL,

  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
`;

export const CREDENTIALS_INDEX_DDL = `
CREATE INDEX credentials_user ON credentials (user_id);
`;

export const INVITES_TABLE_DDL = `
CREATE TABLE invites (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  code       TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
`;

export const REFRESH_TOKENS_TABLE_DDL = `
CREATE TABLE refresh_tokens (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,

  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  replaced_by TEXT REFERENCES refresh_tokens (id) ON DELETE SET NULL,

  device_label TEXT NOT NULL,
  -- Rotation lineage (#858): a login starts a family, every rotation stays in
  -- it, and reuse detection revokes one family rather than the whole user.
  family_id         TEXT,
  family_revoked_at TEXT,
  -- Device-session platform marker, e.g. 'tvos'.
  platform TEXT,
  -- False only for the LAN-handoff redeem, whose cookie answers on a
  -- plain-HTTP LAN origin. NULL reads as true.
  secure INTEGER CHECK (secure IS NULL OR secure IN (0, 1))
);
`;

export const REFRESH_TOKENS_INDEX_DDL = `
CREATE INDEX refresh_tokens_user   ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id) WHERE family_id IS NOT NULL;
`;

export const SERVICE_API_KEYS_TABLE_DDL = `
CREATE TABLE service_api_keys (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  -- Public, non-secret lookup identifier embedded in the key prefix.
  key_id TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL,
  -- SHA-256 of the secret. Plaintext is never persisted.
  secret_hash TEXT NOT NULL,
  scopes      TEXT NOT NULL CHECK (json_valid(scopes)),

  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users (id),
  expires_at   TEXT,
  revoked_at   TEXT,
  last_used_at TEXT
);
`;

export const SERVICE_API_KEYS_INDEX_DDL = `
CREATE INDEX service_api_keys_expiry  ON service_api_keys (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX service_api_keys_revoked ON service_api_keys (revoked_at) WHERE revoked_at IS NOT NULL;
`;

/** WebAuthn ceremony challenge. Five-minute lifetime, single use. */
export const CHALLENGES_TABLE_DDL = `
CREATE TABLE challenges (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  challenge   TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate', 'add_credential')),
  user_id     TEXT REFERENCES users (id) ON DELETE CASCADE,
  email       TEXT,
  invite_code TEXT,
  expires_at  TEXT NOT NULL
);
`;

/**
 * The two single-use handoff code tables. Both hash the code, both are
 * short-lived, and neither stores anything the raw code could be recovered
 * from. `native_auth_codes` carries a PKCE challenge; the LAN handoff
 * deliberately does not, because both origins are the same browser tab and
 * there is no side channel a verifier would travel on.
 */
export const NATIVE_AUTH_CODES_TABLE_DDL = `
CREATE TABLE native_auth_codes (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  code_hash      TEXT NOT NULL UNIQUE,
  code_challenge TEXT NOT NULL,
  state          TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_label   TEXT NOT NULL,

  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
`;

export const LAN_HANDOFF_CODES_TABLE_DDL = `
CREATE TABLE lan_handoff_codes (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  code_hash    TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_label TEXT NOT NULL,

  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
`;

/** Short-lived bearer tokens for direct image URLs. */
export const IMAGE_ACCESS_TOKENS_TABLE_DDL = `
CREATE TABLE image_access_tokens (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) = 24),

  token_hash TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

/**
 * The expiry indexes for every table that used a Mongo TTL index. Grouped here
 * so the sweeper and the schema are obviously talking about the same set.
 */
export const EXPIRY_INDEX_DDL = `
CREATE INDEX invites_expiry             ON invites (expires_at);
CREATE INDEX refresh_tokens_expiry      ON refresh_tokens (expires_at);
CREATE INDEX challenges_expiry          ON challenges (expires_at);
CREATE INDEX native_auth_codes_expiry   ON native_auth_codes (expires_at);
CREATE INDEX lan_handoff_codes_expiry   ON lan_handoff_codes (expires_at);
CREATE INDEX image_access_tokens_expiry ON image_access_tokens (expires_at);
`;

/**
 * Tables whose rows expire, and the column that says when. The periodic sweep
 * is a `DELETE FROM <table> WHERE <column> < ?` per entry.
 */
export const EXPIRING_TABLES = [
  { table: 'invites', column: 'expires_at' },
  { table: 'refresh_tokens', column: 'expires_at' },
  { table: 'challenges', column: 'expires_at' },
  { table: 'native_auth_codes', column: 'expires_at' },
  { table: 'lan_handoff_codes', column: 'expires_at' },
  { table: 'image_access_tokens', column: 'expires_at' },
  { table: 'upload_sessions', column: 'expires_at' },
] as const;
