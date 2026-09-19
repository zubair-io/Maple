/**
 * Authentication collections: users, passkeys, invites, refresh tokens, service
 * API keys, and the three short-lived single-use code tables.
 *
 * These carry across because the alternative is visible to every user on the
 * first boot after a cutover: dropping `refresh_tokens` signs out every device
 * on every platform, and dropping `invites` silently voids invitations already
 * sent. The short-lived tables cost almost nothing to bring and keep the row
 * counts honest, so they come too.
 *
 * ## The one collection deliberately left behind
 *
 * `image_access_tokens` is NOT imported, and the reason is a shape mismatch
 * rather than an oversight. On MongoDB the document is keyed by the SHA-256 of
 * the token, carries the exact URL path it is bound to, and names no user; the
 * SQLite table in `ddl/auth.ts` is keyed by a 24-character id, stores the hash
 * in `token_hash`, and requires a `user_id` foreign key. There is no honest
 * mapping between the two, and inventing one would mean minting a user
 * attribution the source never recorded.
 *
 * Nothing is lost by leaving them: these are capability tokens for thumbnail
 * and preview URLs with a lifetime measured in minutes, and a client that finds
 * one rejected mints another on its next request. The cutover's own downtime is
 * longer than the tokens live.
 *
 * ## TTL becomes a sweep
 *
 * Six of these collections rely on MongoDB's TTL monitor to delete expired
 * rows. SQLite has none, so the schema replaces it with an indexed
 * `expires_at` and an explicit periodic DELETE. Expired rows present in the
 * source at import time are carried over and swept afterwards rather than
 * filtered here, so the row counts the verifier compares are counts of the same
 * set on both sides.
 */

import type { CollectionPlan } from '../types.ts';
import {
  idToHex,
  intOr,
  requireIdHex,
  toBlob,
  toEnum,
  toIso,
  toJsonText,
  toNullableBit,
  toText,
  textOr,
} from '../values.ts';
import { docId, onePerDocument } from './shared.ts';

const EPOCH = new Date(0).toISOString();
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z').toISOString();

const usersPlan = onePerDocument({
  source: 'users',
  table: 'users',
  columns: ['id', 'email', 'role', 'file_access', 'created_at', 'last_seen_at'],
  values: (doc) => {
    const role = toEnum(doc.role, ['owner', 'member'] as const);
    if (role === null) throw new Error(`unknown user role ${String(doc.role)}`);
    return [
      docId(doc),
      textOr(doc.email, ''),
      role,
      toNullableBit(doc.file_access),
      toIso(doc.created_at) ?? EPOCH,
      toIso(doc.last_seen_at),
    ];
  },
});

const credentialsPlan = onePerDocument({
  source: 'credentials',
  table: 'credentials',
  columns: [
    'id',
    'user_id',
    'credential_id',
    'public_key',
    'counter',
    'transports',
    'device_label',
    'created_at',
    'last_used_at',
  ],
  values: (doc) => {
    const publicKey = toBlob(doc.public_key);
    if (publicKey === null) throw new Error('public_key is missing');
    return [
      docId(doc),
      requireIdHex(doc.user_id, 'user_id'),
      textOr(doc.credential_id, ''),
      publicKey,
      intOr(doc.counter, 0),
      toJsonText(doc.transports),
      textOr(doc.device_label, ''),
      toIso(doc.created_at) ?? EPOCH,
      toIso(doc.last_used_at),
    ];
  },
});

const invitesPlan = onePerDocument({
  source: 'invites',
  table: 'invites',
  columns: ['id', 'code', 'email', 'invited_by', 'expires_at', 'consumed_at'],
  values: (doc) => [
    docId(doc),
    textOr(doc.code, ''),
    textOr(doc.email, ''),
    requireIdHex(doc.invited_by, 'invited_by'),
    toIso(doc.expires_at) ?? FAR_FUTURE,
    toIso(doc.consumed_at),
  ],
});

const refreshTokensPlan = onePerDocument({
  source: 'refresh_tokens',
  table: 'refresh_tokens',
  columns: [
    'id',
    'user_id',
    'token_hash',
    'issued_at',
    'expires_at',
    'revoked_at',
    'replaced_by',
    'device_label',
    'family_id',
    'family_revoked_at',
    'platform',
    'secure',
  ],
  values: (doc) => [
    docId(doc),
    requireIdHex(doc.user_id, 'user_id'),
    textOr(doc.token_hash, ''),
    toIso(doc.issued_at) ?? EPOCH,
    toIso(doc.expires_at) ?? FAR_FUTURE,
    toIso(doc.revoked_at),
    idToHex(doc.replaced_by),
    textOr(doc.device_label, ''),
    idToHex(doc.family_id),
    toIso(doc.family_revoked_at),
    toText(doc.platform),
    toNullableBit(doc.secure),
  ],
});

const serviceApiKeysPlan = onePerDocument({
  source: 'service_api_keys',
  table: 'service_api_keys',
  columns: [
    'id',
    'key_id',
    'name',
    'secret_hash',
    'scopes',
    'created_at',
    'created_by',
    'expires_at',
    'revoked_at',
    'last_used_at',
  ],
  values: (doc) => [
    docId(doc),
    textOr(doc.key_id, ''),
    textOr(doc.name, ''),
    textOr(doc.secret_hash, ''),
    toJsonText(doc.scopes) ?? '[]',
    toIso(doc.created_at) ?? EPOCH,
    requireIdHex(doc.created_by, 'created_by'),
    toIso(doc.expires_at),
    toIso(doc.revoked_at),
    toIso(doc.last_used_at),
  ],
});

const challengesPlan = onePerDocument({
  source: 'challenges',
  table: 'challenges',
  columns: ['id', 'challenge', 'purpose', 'user_id', 'email', 'invite_code', 'expires_at'],
  values: (doc) => {
    const purpose = toEnum(doc.purpose, ['register', 'authenticate', 'add_credential'] as const);
    if (purpose === null) throw new Error(`unknown challenge purpose ${String(doc.purpose)}`);
    return [
      docId(doc),
      textOr(doc.challenge, ''),
      purpose,
      idToHex(doc.user_id),
      toText(doc.email),
      toText(doc.invite_code),
      toIso(doc.expires_at) ?? EPOCH,
    ];
  },
});

const nativeAuthCodesPlan = onePerDocument({
  source: 'native_auth_codes',
  table: 'native_auth_codes',
  columns: [
    'id',
    'code_hash',
    'code_challenge',
    'state',
    'user_id',
    'device_label',
    'created_at',
    'expires_at',
    'consumed_at',
  ],
  values: (doc) => [
    docId(doc),
    textOr(doc.code_hash, ''),
    textOr(doc.code_challenge, ''),
    textOr(doc.state, ''),
    requireIdHex(doc.user_id, 'user_id'),
    textOr(doc.device_label, ''),
    toIso(doc.created_at) ?? EPOCH,
    toIso(doc.expires_at) ?? EPOCH,
    toIso(doc.consumed_at),
  ],
});

const lanHandoffCodesPlan = onePerDocument({
  source: 'lan_handoff_codes',
  table: 'lan_handoff_codes',
  columns: [
    'id',
    'code_hash',
    'user_id',
    'device_label',
    'created_at',
    'expires_at',
    'consumed_at',
  ],
  values: (doc) => [
    docId(doc),
    textOr(doc.code_hash, ''),
    requireIdHex(doc.user_id, 'user_id'),
    textOr(doc.device_label, ''),
    toIso(doc.created_at) ?? EPOCH,
    toIso(doc.expires_at) ?? EPOCH,
    toIso(doc.consumed_at),
  ],
});

/** Auth plans, in foreign-key order — `users` first, everything else after. */
export const AUTH_PLANS: CollectionPlan[] = [
  usersPlan,
  credentialsPlan,
  invitesPlan,
  refreshTokensPlan,
  serviceApiKeysPlan,
  challengesPlan,
  nativeAuthCodesPlan,
  lanHandoffCodesPlan,
];
