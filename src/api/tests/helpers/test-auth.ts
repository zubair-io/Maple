/**
 * Test helper: a stand-in for `requireAuth` when a route MODULE is mounted
 * directly (without the app-level `authedApi` wrapper).
 *
 * Since #2893, several route modules carry their own auth context needs:
 * whole-module gates (`.use(requireFileAccess)` in fs.ts, changes.ts, …)
 * embed the real `requireAuth`, and per-route
 * `{ beforeHandle: requireFileAccessBeforeHandle }` handlers (folders.ts,
 * assets/*.ts) read `auth` from the surrounding context. Tests that mount
 * such a module bare would 401/403 on every request.
 *
 * This plugin is *named* `requireAuth`, so Elysia's plugin deduplication
 * makes the module-internal `.use(requireAuth)` a no-op — the stub's derive
 * supplies the `auth` context instead, with no bearer required. Pass
 * overrides to model a restricted user (e.g. `{ file_access: false }`).
 */
import { Elysia } from 'elysia';
import type { AccessClaims } from '../../src/auth/tokens.ts';

export function fakeAuth(overrides: Partial<AccessClaims> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = {
    sub: '0'.repeat(24),
    email: 'test@maple.local',
    role: 'owner',
    file_access: true,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  return new Elysia({ name: 'requireAuth' }).derive({ as: 'scoped' }, () => ({
    auth: { user: claims },
  }));
}
