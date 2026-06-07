# Authentication & Sessions — Architecture

> **Status:** as-built description of the current implementation (2026-06-02).
> Documents what the code does today, including known issues. Endpoint
> reference in [`server-api.md`](server-api.md) is **stale for auth** (see
> [Known issues](#known-issues--risks) §6) — this doc supersedes it for the
> auth surface. Operator upgrade notes: [`upgrade-notes/2026-04-passkey-auth.md`](upgrade-notes/2026-04-passkey-auth.md).

## Context & goals

Maple Self Hosted is a single-tenant server one person (the **owner**) claims on
first run and optionally invites **members** into. The same Bun/Elysia API backs
three clients — the Angular web app, and the Apple shell (macOS/iOS/iPad) which
loads the web app and also talks to the API directly.

Design intent:

- **Passwordless.** Identity is proven with **WebAuthn / passkeys** only. There
  are no passwords anywhere in the system.
- **Short-lived, revocable request auth.** `/api/*` is gated by a JWT bearer
  token. Verification is mostly self-contained (signature + `exp`), plus one
  indexed `_id` lookup of the user's `token_version` (#860) so a bumped version
  instantly invalidates live access tokens. Tokens are short-lived (15 min), so
  the lookup rate is bounded and a lost token self-expires quickly.
- **Stateful, revocable login.** A rotating refresh token, recorded server-side,
  is the durable session and a revocation point (alongside `token_version`).

The security-critical identity ceremony is delegated to a maintained library
(`@simplewebauthn/server`), and JWT sign/verify to `jose` (#859, algorithm
pinned to HS256). The refresh-store state machine on top is the hand-rolled
domain logic.

## The model at a glance

Two distinct tokens with different lifecycles. Conflating them is the source of
most confusion:

|                      | **Access token (JWT)**                                   | **Refresh token**                                |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Format               | HS256 JWT via `jose` (#859)                              | opaque 32-byte random (base64url)                |
| Proves               | "this request is authorized"                             | "this device has a live login"                   |
| Server-side record   | `token_version` on the user doc (#860)                   | row in `refresh_tokens` (stored as SHA-256 hash) |
| Lifetime             | **15 min**, fixed at issue (#860)                        | 90 days, rotates on every use                    |
| Revocable?           | **yes** — bump `token_version` (#860), else self-expires | yes — `revoked_at` / family + chain revoke       |
| Where it lives (web) | **memory only**, lost on reload                          | httpOnly cookie `maple_refresh`                  |
| Transport            | `Authorization: Bearer` (HTTP), `?token=` (WebSocket)    | cookie; also JSON body (native)                  |
| Verified by          | signature + `exp` + `token_version` match                | hash lookup + `revoked_at`/`expires_at` checks   |

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
| [`src/api/src/auth/middleware.ts`](../src/api/src/auth/middleware.ts)                                       | `requireAuth` / `requireOwner` Elysia guards (verify + `token_version` check)                    |
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
- **Claims:** `sub` (user id, hex), `email`, `role`, `tv` (token_version, #860),
  `iat`, `exp`.
- **TTL: 15 min** (`ACCESS_TTL_SECONDS`, #860). Short enough that a leaked token
  self-expires quickly; rotation (#858) absorbs the higher refresh cadence.
- **Verification** (`verifyAccessToken`) verifies the signature with the
  algorithm **pinned to `['HS256']`**, so `alg:none` / RS256→HS256 confusion is
  rejected by construction, then checks `exp`. It does **not** validate
  `iss` / `aud` / `nbf`, and there is no `jti`.
- **One DB read at verify time** (#860): `requireAuth` loads the user's
  `token_version` by indexed `_id` and rejects the token if its `tv` claim is
  behind. A non-ObjectId `sub` or a not-yet-persisted user falls through to a
  stateless accept (keeps bootstrap/test bearers working), bounded by the 15-min
  TTL. Bumping `token_version` (e.g. via `revokeChain`) is the instant
  per-user "kill now" lever.

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
   pair. (`requireUserVerification: false` — "preferred", to accept synced
   passkeys / keys without UV; see `webauthn.ts:114`.)

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

1. **Refresh rotation is non-idempotent with zero replay tolerance → spurious
   logouts.** Any presentation of an already-rotated token is treated as theft
   and revokes the user's _entire_ token family. Because the web app rotates the
   cookie on every load, any time a `/refresh` response fails to reach the tab
   that sent it (lost response on a flaky link; a slow `/refresh` — see the API
   event-loop stalls, #706–#710 — while the user reloads/navigates; concurrency
   the Web-Lock can't cover such as a second device), the client keeps the old
   cookie while the server has revoked it, and the next refresh trips reuse
   detection. Contributing factors:
   - `replaced_by` is written but **never read** — there is no grace-window
     "return the existing successor for a just-rotated token" path
     (`refresh_store.ts:32, 41-46`).
   - `revokeChain` is **per-user**, not per-chain, so one slip signs the user out
     on every device (`refresh_store.ts:49-55`).
   - `rotateRefreshToken` reads-checks-then-writes non-atomically (TOCTOU) — two
     same-token requests can both pass the check (`refresh_store.ts:25-46`).
   - No concurrency / lost-response test exists (only sequential reuse tests).
2. **~~30-day, non-revocable access token → "valid" ≠ "fresh".~~** RESOLVED
   (#860). TTL is now 15 min, and `requireAuth` checks the user's
   `token_version` per request, so bumping it (`revokeChain`) kills live access
   tokens within one verify.
3. **~~Hand-rolled JWT.~~** RESOLVED (#859). Sign/verify is now `jose` with the
   algorithm pinned to HS256; the hand-rolled envelope and `timingSafeEqual` are
   deleted.
4. **In-memory rate limiter.** `rate_limit.ts` is per-process (not shared across
   replicas/restarts) and never evicts map keys. Effectiveness depends on the
   single-process deployment shape.
5. **WebSocket token in the query string.** `?token=<jwt>` can land in access
   logs / proxy logs. Lower risk with a short access TTL; a post-connect auth
   frame would be better.
6. **Doc drift.** [`server-api.md`](server-api.md) §Authentication lists endpoints
   that don't exist (`/api/auth/status`, `/register/{begin,finish}`,
   `/login/{begin,finish}`). The real surface is documented above.

## Recommended direction

Treat as one **auth-hardening** effort (no ticket yet):

- **Shorten the access TTL** to ~5–15 min and make the DB-backed refresh layer
  the real control point. This bounds staleness (#2) and de-risks the
  token-in-URL exposure (#5) without adding a per-request DB read. Optionally add
  a `token_version` on the user (or a small denylist) for instant revocation.
- **Make rotation safe** (#1): atomic CAS
  `findOneAndUpdate({ token_hash, revoked_at: null }, …)`; a grace window that
  returns the live `replaced_by` successor when the immediately-prior token is
  replayed within ~10–30 s; consider chain-scoped rather than per-user
  revocation. Add a concurrency/lost-response regression test.
- **Consider migrating the JWT to `jose`** (#3).
- **Fix `server-api.md`** (#6).

## References

- Operator upgrade note: [`upgrade-notes/2026-04-passkey-auth.md`](upgrade-notes/2026-04-passkey-auth.md)
- API reference (stale for auth): [`server-api.md`](server-api.md)
- Config conventions (env vs. DB settings): [`../CLAUDE.md`](../CLAUDE.md) §Conventions
