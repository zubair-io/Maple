// Per-user permission resolution (#2893).
//
// One place decides what a user document's permission fields mean, so every
// access-token mint site and the /me endpoint agree byte-for-byte.

import type { WithId } from 'mongodb';
import type { UserDoc, UserRole } from '../db/schema.ts';

/**
 * Effective "file access" permission for a user document. Owners always
 * have it; members have it unless an operator explicitly revoked it
 * (`file_access: false`). Absent = granted, which keeps every pre-#2893
 * member exactly as capable as they were.
 */
export function userFileAccess(user: { role: UserRole; file_access?: boolean }): boolean {
  return user.role === 'owner' || user.file_access !== false;
}

/**
 * The wire shape of a signed-in user in auth payloads (`/api/auth/me`,
 * every login/redeem flow). One builder so the five mint sites can't
 * drift on which fields ride along.
 */
export function toPublicAuthUser(user: WithId<UserDoc>): {
  id: string;
  email: string;
  role: UserRole;
  file_access: boolean;
} {
  return {
    id: user._id.toHexString(),
    email: user.email,
    role: user.role,
    file_access: userFileAccess(user),
  };
}
