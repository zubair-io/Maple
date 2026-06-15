# Authentication & Sessions — Architecture

> **Status:** as-built description of the current implementation, updated through
> the #852 auth rebuild (Phases 0–4). This doc is the authoritative reference for
> the auth surface; [`server-api.md`](server-api.md) §Authentication now points
> here and to the generated `/openapi.json` as canonical. Operator upgrade notes:
> [`upgrade-notes/2026-04-passkey-auth.md`](upgrade-notes/2026-04-passkey-auth.md).

## Context & goals

Maple Self Hosted is a single-tenant server one person (the **owner**) claims on
first run and optionally invites **members** into. The same Bun/Elysia API backs
three clients — the Angular web app, and the Apple shell (macOS/iOS/iPad) which
loads the web app and also talks to the API directly.

Design intent:

- **Passwordless.** Identity is proven with **WebAuthn / passkeys** only. There
  are no passwords anywhere in the system.
- **Stateless request auth.** `/api/*` is gated by a JWT bearer token, verified
  on signature + `exp` only — **no per-request DB read** (the hot path is hit
  constantly by photo backup + thumbnail traffic). Tokens are short-lived
  (15 min), which is what bounds revocation: a revoked session's in-flight
  access token simply ages out and can't be renewed.
- **Stateful, revocable login.** A rotating refresh token, recorded server-side,
  is the durable session and the revocation point.

The security-critical identity ceremony is delegated to a maintained library
(`@simplewebauthn/server`), and JWT sign/verify to `jose` (#859, algorithm
pinned to HS256). The refresh-store state machine on top is the hand-rolled
domain logic.

## The model at a glance

Two distinct tokens with different lifecycles. Conflating them is the source of
most confusion:

|                      | **Access token (JWT)**                                 | **Refresh token**                                |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Format               | HS256 JWT via `jose` (#859)                            | opaque 32-byte random (base64url)                |
| Proves               | "this request is authorized"                           | "this device has a live login"                   |
| Server-side record   | **none** (stateless)                                   | row in `refresh_tokens` (stored as SHA-256 hash) |
| Lifetime             | **15 min**, fixed at issue (#860)                      | 90 days, rotates on every use                    |
| Revocable?           | indirectly — self-expires ≤15 min once refresh revoked | yes — `revoked_at` / family + chain revoke       |
| Where it lives (web) | **memory only**, lost on reload                        | httpOnly cookie `maple_refresh`                  |
| Transport            | `Authorization: Bearer` (HTTP), `?token=` (WebSocket)  | cookie; also JSON body (native)                  |
| Verified by          | signature + `exp` only                                 | hash lookup + `revoked_at`/`expires_at` checks   |

```
        ┌──────────── Web (Angular) ─────────────┐
        │ AuthService                             │
        │   accessToken  : in-memory only         │      Authorization: Bearer <JWT>
        │   refresh cookie: httpOnly (browser)    │ ───────────────────────────────────►  ┌───────── API (Elysia) ─────────┐
        │   cross-tab: Web Locks + BroadcastChannel│      Cookie: maple_refresh=<opaque>    │ requireAuth middleware          │
        └─────────────────────────────────────────┘ ◄───────────────────────────────────  │   verifyAccessToken (sig + exp) │
                                                            Set-Cookie (rotated)            │                                 │
        ┌──────────── Apple shell ────────────────┐                                        │ /api/auth/* routes              │
        │ ASWebAuthenticationSession → web auth    │      scheme://auth-success?...tokens   │   WebAuthn ceremony ──┐         │
        │ captures tokens via custom-scheme redirect│ ◄──────────────────────────────────── │   rotateRefreshToken ─┼─► MongoDB│
        └──────────────────────────────────────────┘                                        └──────────────────────┴─────────┘
                                                                                  users · credentials · refresh_tokens · challenges · invites · server_state
```

## Components

| File                                                                                                        | Responsibility                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`src/api/src/auth/tokens.ts`](../src/api/src/auth/tokens.ts)                                               | HS256 JWT sign/verify via `jose` (alg-pinned); refresh-token generation + hashing; TTL constants |
| [`src/api/src/auth/refresh_store.ts`](../src/api/src/auth/refresh_store.ts)                                 | Refresh-token issue / **rotate** / reuse-detection / revoke (Mongo)                              |
| [`src/api/src/auth/webauthn.ts`](../src/api/src/auth/webauthn.ts)                                           | Passkey ceremony via `@simplewebauthn/server`; challenge store/consume                           |
| [`src/api/src/auth/middleware.ts`](../src/api/src/auth/middleware.ts)                                       | `requireAuth` / `requireOwner` Elysia guards (stateless verify) + `stepUpBeforeHandle`           |
| [`src/api/src/auth/rate_limit.ts`](../src/api/src/auth/rate_limit.ts)                                       | In-memory per-process sliding-window limiter                                                     |
| [`src/api/src/auth/jwt-bootstrap.ts`](../src/api/src/auth/jwt-bootstrap.ts) + `jwt-secret.repo.ts`          | Resolve the HS256 secret at startup (DB → file → memory)                                         |
| [`src/api/src/auth/invites.ts`](../src/api/src/auth/invites.ts)                                             | Create / redeem / list / rescind invites                                                         |
| [`src/api/src/routes/auth.ts`](../src/api/src/routes/auth.ts)                                               | All `/api/auth/*` HTTP endpoints                                                                 |
| [`src/api/src/routes/events.ts`](../src/api/src/routes/events.ts)                                           | WebSocket `/api/events`, authed via `?token=`                                                    |
| [`src/web/.../auth/auth.service.ts`](../src/web/projects/maple-common/src/lib/auth/auth.service.ts)         | Web token state, refresh coalescing, cross-tab coordination                                      |
| [`src/web/.../auth/auth.interceptor.ts`](../src/web/projects/maple-common/src/lib/auth/auth.interceptor.ts) | Attach bearer; refresh-and-retry on 401                                                          |
| [`src/web/.../auth/auth-bootstrap.ts`](../src/web/projects/maple-common/src/lib/auth/auth-bootstrap.ts)     | App-initializer session rehydration on every load                                                |
| [`src/web/.../auth/auth.guard.ts`](../src/web/projects/maple-common/src/lib/auth/auth.guard.ts)             | Route guard                                                                                      |

## Data model

All in MongoDB; schemas in [`src/api/src/db/schema.ts`](../src/api/src/db/schema.ts), indexes
in [`ensureIndexes()`](../src/api/src/db/client.ts) (`client.ts:1009+`).

- **`users`** — `{ email (unique, lowercased, ci-collation), role: "owner"|"member", created_at, last_seen_at }`
- **`credentials`** — one user → many passkeys. `{ user_id, credential_id (unique), public_key, counter, transports[], device_label, created_at, last_used_at }`
- **`refresh_tokens`** — the session store. `{ user_id, token_hash (unique, = sha256(raw)), issued_at, expires_at (Date, TTL), revoked_at, replaced_by, device_label }`
- **`challenges`** — WebAuthn challenges, 5-min TTL. `{ challenge, purpose: register|authenticate|add_credential, user_id, email, invite_code, expires_at (Date, TTL) }`
- **`invites`** — `{ code (unique), email, expires_at (TTL), consumed_at, … }`
- **`server_state`** — singletons incl. `_id: "jwt_secret"` (the HS256 key).

**TTL behavior:** `refresh_tokens`, `challenges`, and `invites` have
`expireAfterSeconds: 0` indexes on `expires_at`, so Mongo's TTL monitor prunes
expired rows automatically. Note: a **revoked-but-unexpired** refresh row is
deliberately _kept_ until its 90-day `expires_at` — reuse detection depends on
being able to recognize a revoked token rather than treat it as unknown.

## Tokens in detail

### Access token (JWT) — `tokens.ts`

- **HS256 via `jose`** (#859). `jose` handles sign/verify; there is no
  hand-rolled JWT envelope or HMAC compare anymore.
- **Claims:** `sub` (user id, hex), `email`, `role`, `iat`, `exp`.
- **TTL: 15 min** (`ACCESS_TTL_SECONDS`, #860). Short enough that a leaked token
  self-expires quickly; rotation (#858) absorbs the higher refresh cadence.
- **Verification** (`verifyAccessToken`) verifies the signature with the
  algorithm **pinned to `['HS256']`**, so `alg:none` / RS256→HS256 confusion is
  rejected by construction, then checks `exp`. It does **not** validate
  `iss` / `aud` / `nbf`, and there is no `jti`.
- **No DB read at verify time** — `requireAuth` is fully stateless (signature +
  `exp`). This keeps the hot path (constant photo-backup/thumbnail traffic) free
  of an auth lookup. The cost is that revocation is bounded by the 15-min TTL
  rather than instant: once a refresh family is revoked, the in-flight access
  token can't be renewed and ages out. (A `token_version` per-request check for
  instant revoke was tried in #860 and removed — the per-request DB read wasn't
  worth it for a single-owner server.)

### Refresh token — `refresh_store.ts`

- Opaque 32 random bytes (base64url) from `node:crypto`. The raw value is
  **never stored**; only `sha256(raw)` is persisted (`token_hash`, unique index).
- **TTL: 90 days.** **Rotates on every `/refresh`:** the presented token is
  marked `revoked_at`, a fresh token is issued, and `replaced_by` is set on the
  old row.
- **Reuse detection:** presenting a token whose `revoked_at` is already set →
  `revokeChain(user_id)` revokes **every live token for that user** → the caller
  gets `401 { error: "refresh token reuse detected — chain revoked" }`.

### Signing secret — `jwt-bootstrap.ts`

Resolved once at startup into `process.env.MAPLE_JWT_SECRET` (min length 16):

1. **DB** — `server_state` doc `jwt_secret` (canonical; shared across instances,
   survives container recreates, so it never silently rotates).
2. **File** — `MAPLE_JWT_SECRET_FILE` (default `./.maple/jwt.secret`, mode 0600),
   only when Mongo is unreachable at boot.
3. **In-memory random** — last resort; logged loudly because it won't survive a
   restart (every restart would then invalidate all access tokens).

A non-reversible fingerprint of the active secret is logged on boot so a
mismatch across replicas/restarts is diagnosable.

## Flows

### Server claim & bootstrap probe

`GET /api/auth/bootstrap` (unauthed) → `{ claimed, dev_login_enabled }`.
`claimed` is true once any user exists. The **first** user to register becomes
`owner` (claims the server); every subsequent registration requires a valid
invite and is created as `member`.

### Registration (`/register/options` → `/register/verify`)

1. `options` (rate-limited 10/min/IP): if already claimed, an invite code is
   required and peeked (must be unconsumed, unexpired, email-matched).
   `generateRegistrationOptions` runs; the challenge is stored (purpose
   `register`).
2. `verify`: the challenge is parsed from `clientDataJSON`, **consumed**
   (`findOneAndDelete` + expiry check), and matched on purpose+email. The
   passkey is verified, the invite (if any) redeemed, the user + credential
   inserted, and an access + refresh pair issued (cookie set).

### Login (`/login/options` → `/login/verify`)

1. `options` (rate-limited): look up user by email (404 if none); build
   authentication options with `allowCredentials` = the user's passkeys; store
   challenge (purpose `authenticate`).
2. `verify`: consume + match the challenge, look up user and credential (by
   `credential_id`, bound to the user), verify the assertion, bump the signature
   `counter` + `last_used_at` / `last_seen_at`, and issue an access + refresh
   pair. (`userVerification: "preferred"` — accepts synced passkeys without
   forcing a UV gesture; an intentional choice, see [Decisions](#decisions-documented).)

### Refresh & rotation (`POST /api/auth/refresh`)

1. Rate-limited 10/min/IP. Token = `body.refresh_token ?? cookie.maple_refresh`
   (web sends an empty body and relies on the cookie; native sends the body).
2. `rotateRefreshToken` rotates or throws (`401` with the error message).
3. The user is re-loaded (`401 user gone` if deleted), a **new** access token is
   signed, and the rotated refresh cookie is re-set.

### Logout (`POST /api/auth/logout`)

`revokeOne(token)` revokes just that one token (not the chain) and the cookie is
cleared. Returns 204.

### Credential & invite management (authed)

- `GET /me` → user + credential list. `POST /credentials/options|verify` adds a
  passkey (purpose `add_credential`, bound to the caller, existing creds in
  `excludeCredentials`). `DELETE /credentials/:id` removes one but refuses to
  remove the **last** credential (409).
- `/invites` is **owner-only** (`requireOwner`): create / list / rescind.

### Dev-login (`POST /api/auth/dev-login`)

Gated on `MAPLE_DEV_AUTH=1`; returns **404** when unset (invisible in prod). When
enabled, upserts a dev user (`dev@maple.local`, owner) and mints the normal
token pair — bypassing the passkey ceremony for local automation.

### Request authorization — `middleware.ts`

`requireAuth` extracts the `Bearer` token, calls `verifyAccessToken`, and exposes
`auth.user = <claims>`. `requireOwner` additionally checks `auth.user.role`. Both
decisions use the **JWT claims** — there is no per-request DB read and no
revocation/denylist check.

### Realtime channel — `events.ts`

`WS /api/events`. Browsers can't set headers on `new WebSocket()`, so the access
token is passed as `?token=<jwt>` and verified statelessly in `beforeHandle`
(401 rejects the upgrade).

## Web client behavior

- **Memory-only access token.** `AuthService.accessToken` is a private field,
  never persisted. Consequence: every reload/new tab starts tokenless.
- **Bootstrap rehydration.** `provideAuthBootstrap` runs one `refresh()` (then
  `/me`) on every app start, blocking boot, so a reload recovers the session from
  the cookie without a visible 401 round-trip.
- **Refresh coalescing & cross-tab coordination** (built specifically to avoid
  tripping reuse detection):
  - _In-tab:_ concurrent `refresh()` callers share one in-flight promise.
  - _Cross-tab:_ the network refresh runs inside a `navigator.locks`
    (`maple-auth-refresh`) critical section, so two tabs can't `/refresh` the
    same cookie concurrently.
  - _Gossip:_ a `BroadcastChannel` ("maple-auth") shares freshly minted access
    tokens (peers adopt within a 5 s window) and `signout` events.
- **Interceptor.** Attaches the bearer (except session-bootstrap paths); on a
  `401` it triggers one `refresh()` and retries the request only if the outcome
  is `refreshed`. Outcomes: `refreshed` / `rejected` (real 401 → clear session) /
  `transient` (offline / 5xx / 429 → **keep** session).

## Apple shell bridge

When the web app is loaded inside `ASWebAuthenticationSession`, the initial URL
carries `?native_callback=<scheme>` (validated `^[a-z][a-z0-9-]*$`). On auth
success the web app redirects to
`<scheme>://auth-success?access_token=…&refresh_token=…&user_id=…&user_email=…&user_role=…`;
the session captures it by scheme. This is the only reason the `refresh_token`
appears in the JSON response bodies (the web app itself relies on the httpOnly
cookie). How the Swift shell persists those tokens is out of scope for this doc.

## Trust boundaries — off-the-shelf vs. rolled

| Off-the-shelf (trusted)               | Used for                                         |
| ------------------------------------- | ------------------------------------------------ |
| `@simplewebauthn/server` + `/browser` | the entire passkey ceremony — the identity proof |
| `@noble/hashes`                       | HMAC-SHA256 + SHA-256 primitives                 |
| `node:crypto`                         | CSPRNG (`randomBytes`), secret fingerprint       |
| Elysia cookie API                     | `Set-Cookie` handling                            |

| Rolled our own                             | Where                                                               |
| ------------------------------------------ | ------------------------------------------------------------------- |
| The JWT itself (sign/verify)               | `tokens.ts`                                                         |
| Constant-time compare                      | `tokens.ts` (`timingSafeEqual`) instead of `crypto.timingSafeEqual` |
| Refresh store + rotation + reuse detection | `refresh_store.ts`                                                  |
| Rate limiter                               | `rate_limit.ts`                                                     |
| Secret bootstrap                           | `jwt-bootstrap.ts` / `jwt-secret.repo.ts`                           |

## Configuration (environment)

These are deploy/infra bootstrap values (legitimately env-based, not DB settings):

- `MAPLE_RP_ID` — WebAuthn RP ID (default `localhost`). Must be the public host.
- `MAPLE_ORIGIN` — allowed WebAuthn origin(s), comma-separated (default: local dev ports).
- `MAPLE_JWT_SECRET` / `MAPLE_JWT_SECRET_FILE` — resolved by the bootstrap; the secret is server-owned, not operator-configured in normal operation.
- `MAPLE_DEV_AUTH=1` — enables `/dev-login` (dev only).

## Known issues & risks

These are real, code-confirmed gaps in the current design. None are in the
WebAuthn/crypto-primitive layer; they cluster in the hand-rolled session layer.

1. **~~Refresh rotation is non-idempotent with zero replay tolerance → spurious
   logouts.~~** RESOLVED (#858). Rotation is now an atomic compare-and-swap; a
   `family_id` scopes revocation to one device (not the whole user); and a
   60 s grace window re-mints a just-rotated token (lost-response / concurrent
   retry) iff its family is still live, so a benign replay no longer trips reuse
   detection. Logout revokes by family. Concurrency/lost-response is regression-
   tested (`refresh_store.test.ts`, `auth-flow-e2e.test.ts`).
2. **~~30-day, non-revocable access token → "valid" ≠ "fresh".~~** RESOLVED
   (#860). TTL dropped from 30 days to **15 min**, so a revoked session's access
   token ages out fast. (A `token_version` per-request DB check for _instant_
   revoke was added in #860 and later removed: the lookup on every `/api/*` hit
   wasn't worth it for a single-owner, backup-heavy workload — the 15-min bound
   is sufficient. `requireAuth` is stateless again.)
3. **~~Hand-rolled JWT.~~** RESOLVED (#859). Sign/verify is now `jose` with the
   algorithm pinned to HS256; the hand-rolled envelope and `timingSafeEqual` are
   deleted.
4. **~~In-memory rate limiter.~~** RESOLVED (#862). The store is now a bounded
   LRU (5000-key cap), and the client key is derived from a trusted proxy hop
   (`MAPLE_TRUSTED_PROXIES`), not the spoofable leftmost `X-Forwarded-For`. Still
   per-process by design (single-instance deployment; see Decisions below).
5. **WebSocket token in the query string.** `?token=<jwt>` can land in access /
   proxy logs. Lower risk now with a 15-min access TTL; the post-connect auth
   frame + Origin allowlist + close-on-revoke is tracked in **#863** (not yet
   landed).
6. **~~Doc drift.~~** RESOLVED (#866). [`server-api.md`](server-api.md)
   §Authentication now lists the real endpoints and points to the generated
   `/openapi.json` as canonical.

Also added since the original audit: step-up re-auth for sensitive actions
(#861) and atomic first-registration claim (#865).

## Status

The auth-hardening effort is tracked as epic **#852**. Phases 0–2 (P0 holes +
rotation core) and Phase 3 (jose, short TTL, step-up) are delivered, plus
Phase 4's rate-limit (#862), registration-atomicity (#865), and
`@simplewebauthn/server` v13 upgrade (#864). Remaining: WebSocket auth
hardening (#863). (Access auth is stateless — the #860 `token_version`
per-request check was reverted; revocation is bounded by the 15-min TTL.)

## Decisions (documented)

- **User verification: `"preferred"`, intentionally.** WebAuthn ceremonies use
  `userVerification: "preferred"` (not `"required"`). This is SimpleWebAuthn's
  deliberate passkeys default: it lets synced/platform passkeys authenticate
  without forcing a PIN/biometric gesture on every device, which is the right UX
  for a single-owner photo app. Treat as a conscious choice, not a gap — revisit
  only if Maple ever promises PIN/biometric-backed assurance.
- **Single-instance JWT secret (fail-closed if scaling out).** The secret
  resolves DB → file → in-memory random (`jwt-bootstrap.ts`). The in-memory
  fallback only survives within one process, so a deployment relying on it is
  **single-instance only** — a second replica would sign with a different secret
  and reject the first's tokens. The DB-backed secret (`server_state.jwt_secret`)
  is what makes multi-instance possible; if Maple ever scales horizontally, make
  the DB secret **mandatory** (fail closed rather than silently minting a
  per-process random key). The same single-process assumption applies to the
  in-memory rate limiter (#862).

## References

- Operator upgrade note: [`upgrade-notes/2026-04-passkey-auth.md`](upgrade-notes/2026-04-passkey-auth.md)
- API reference (stale for auth): [`server-api.md`](server-api.md)
- Config conventions (env vs. DB settings): [`../CLAUDE.md`](../CLAUDE.md) §Conventions
