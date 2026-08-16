// Per-user permission resolution (#2893).
//
// One place decides what a user document's permission fields mean, so every
// access-token mint site and the /me endpoint agree byte-for-byte.

import type { UserRole } from '../db/schema.ts';

/**
 * Effective "file access" permission for a user document. Owners always
 * have it; members have it unless an operator explicitly revoked it
 * (`file_access: false`). Absent = granted, which keeps every pre-#2893
 * member exactly as capable as they were.
 */
export function userFileAccess(user: { role: UserRole; file_access?: boolean }): boolean {
  return user.role === 'owner' || user.file_access !== false;
}
