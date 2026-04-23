/**
 * WebAuthn / passkey auth scaffold — Phase 5 deferral.
 *
 * Per spec § 00 "Phase 5": authentication is deferred. These routes exist
 * but enforce nothing. A future phase will complete the implementation.
 *
 * Routes:
 *   POST /api/auth/register — initiate WebAuthn registration
 *   POST /api/auth/verify   — verify WebAuthn assertion
 *   GET  /api/auth/status   — returns { authenticated: true } always (no enforcement)
 */

import { Elysia, t } from "elysia";

const PHASE5_NOTE =
  "WebAuthn auth is deferred to Phase 5 (spec § 00). " +
  "No enforcement is active in this build.";

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  // Registration challenge
  .post(
    "/register",
    async ({ body, set }) => {
      // TODO (Phase 5): generate WebAuthn registration challenge,
      // store pending challenge in session, return PublicKeyCredentialCreationOptions.
      console.info("[auth] /register called (no-op — Phase 5 deferred)");
      set.status = 501;
      return {
        error: "Not implemented",
        note: PHASE5_NOTE,
        email: body.email,
      };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
      }),
    }
  )

  // Assertion verification
  .post(
    "/verify",
    async ({ set }) => {
      // TODO (Phase 5): verify WebAuthn assertion, set session cookie.
      console.info("[auth] /verify called (no-op — Phase 5 deferred)");
      set.status = 501;
      return {
        error: "Not implemented",
        note: PHASE5_NOTE,
      };
    }
  )

  // Auth status (always authenticated in this build — no enforcement)
  .get("/status", () => ({
    authenticated: true,
    note: PHASE5_NOTE,
  }));
