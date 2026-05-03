# Passkey auth + invite-only multi-user — design

**Status:** approved (brainstorming complete, awaiting plan)
**Scope:** `src/api`, `src/apple`, `src/web`
**No-touch:** `src/raw-pipeline`, `docs/sidecar-schema.md`

## 1. Goals

Replace the deferred Phase 5 auth scaffold (`src/api/src/routes/auth.ts`) with a real WebAuthn / passkey implementation that:

1. Gates every `/api/*` route behind a valid session.
2. Lets a fresh self-hosted server be claimed by its first user as `owner`.
3. Lets the owner add additional users in-app via single-use invite codes.
4. Works identically from the Apple app and the Angular web bundle the API serves.
5. Touches neither the RAW pipeline nor the XMP sidecar schema.

## 2. Non-goals

- Per-user library scoping (all authenticated users see the same folders).
- Per-user XMP edits (sidecars remain a single shared truth).
- SSO / OIDC / password fallback.
- Email-based invite delivery (codes are shared out-of-band; QR pairing is the convenience channel).
- Web-side passkey roaming for browsers without platform-authenticator support — those users sign in from the Apple app.

## 3. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Invite-only multi-user, no self-signup | Matches "small server for me + trusted people" mental model. |
| D2 | Auth-only scoping; no per-user data | Keeps XMP schema unchanged (CLAUDE.md invariant). Defers harder question until demanded. |
| D3 | Single `owner` role + `member` role | Only role distinction needed: who can invite/remove users. |
| D4 | 30-day access JWT, rotating refresh token (90-day TTL) | Long-lived access token simplifies offline UX; refresh rotation detects theft. |
| D5 | `@simplewebauthn/server` + `@simplewebauthn/browser` | Bun-compatible, well-maintained, ships test helpers. |
| D6 | Credentials split from users (1:N) | Adding a second device is a first-class operation, not a migration. |
| D7 | Refresh tokens stored hashed (SHA-256) server-side | Server compromise does not hand out live sessions. |
| D8 | Apple stores tokens in existing SelfHosted Keychain entry, scoped per-server-URL | Reuses commit `2650c95` infrastructure; supports multi-server sign-in. |
| D9 | Web stores access in memory + refresh in `httpOnly` cookie (Secure, SameSite=Lax) | JS cannot exfiltrate refresh token. |
| D10 | Cross-platform contract enforced via shared JSON fixture | API and clients validate against the same file; drift in either direction fails CI. |

## 4. Architecture

### 4.1 Server (`src/api`)

- New collections: `users`, `credentials`, `invites`, `refresh_tokens`, `webauthn_challenges` (last three with TTL indexes).
- New module `src/api/src/auth/`:
  - `webauthn.ts` — `@simplewebauthn/server` wrappers (registration + authentication ceremonies).
  - `tokens.ts` — JWT signing/verification + refresh-token issuance, hashing, rotation, theft detection.
  - `middleware.ts` — `requireAuth`, `requireOwner` Elysia middleware.
  - `invites.ts` — code generation (8-char base32, single-use, 15-min TTL), redemption, rescission.
- `src/api/src/routes/auth.ts` — replace stub with the routes in §5.
- `src/api/src/index.ts` — apply `requireAuth` to all `/api/*` routes except `/api/auth/*` and `/api/health`.
- Env: `MAPLE_JWT_SECRET` (required at boot; if unset, generate 32 random bytes once and persist to `<data-dir>/jwt.secret` — fail loud on permission errors).

### 4.2 Apple (`src/apple`)

- New module `Packages/MapleCore/Sources/MapleCore/Auth/`:
  - `AuthClient.swift` — WebAuthn ceremonies via `ASAuthorizationPlatformPublicKeyCredentialProvider`; `/api/auth` request layer.
  - `TokenStore.swift` — Keychain-backed access + refresh token storage, scoped per server URL.
  - `AuthenticatedHTTPClient.swift` — wraps the existing Self-Hosted transport; injects `Authorization: Bearer …`; single-flight refresh on 401; emits `.signedOut` on refresh failure.
  - `AuthSession.swift` — `@Observable`, exposes `currentUser`, `isOwner`, `isSignedIn`, `signOut()`.
- New views in `src/apple/Maple/Views/`:
  - `SignInView.swift` — probes `/api/auth/bootstrap`; routes to claim or sign-in.
  - `JoinWithInviteView.swift` — URL + email + invite code; reachable from QR scanner.
  - `AccountSettingsView.swift` — shows user, role, enrolled passkeys, "Add another device".
  - `ManageUsersView.swift` — owner-only; invite/list/rescind/remove.
- Wire-up: `MapleApp.swift` injects `AuthSession`; `AppShell.swift` gates Self-Hosted UI on `isSignedIn`; `LibrarySelection` / `LibrarySidebar` route through `SignInView` when no session.

### 4.3 Web (`src/web`)

- New library code in `projects/maple-common/src/lib/auth/`:
  - `auth.service.ts` — mirrors Apple's `AuthClient`; uses `@simplewebauthn/browser` for ceremonies.
  - `auth.interceptor.ts` — Angular HTTP interceptor; bearer injection + single-flight refresh on 401.
  - `auth.guard.ts` — route guard; redirects unauthenticated users to `/sign-in`.
- New routes in `projects/maple/`: `/sign-in`, `/join`, `/settings/account`, `/settings/users` (owner-only).
- Refresh token lives in `maple_refresh` cookie (`httpOnly`, `Secure`, `SameSite=Lax`) set by the API on `/login/verify`, `/register/verify`, and `/refresh`. Access token in memory only.
- Service worker: unchanged. Cached shell loads offline; `/api/*` calls without a session return 401 (the SW does not cache auth-gated responses).

## 5. Data model (MongoDB)

```ts
// users
{
  _id: ObjectId,
  email: string,              // unique (case-insensitive index), lowercased on write
  role: "owner" | "member",
  created_at: string,         // ISO
  last_seen_at: string | null,
}

// credentials  (one user → many passkeys)
{
  _id: ObjectId,
  user_id: ObjectId,
  credential_id: string,      // base64url, unique
  public_key: Buffer,         // COSE key
  counter: number,            // WebAuthn signature counter
  transports: string[],       // ["internal","hybrid",...]
  device_label: string,       // user-supplied
  created_at: string,
  last_used_at: string | null,
}

// invites  (TTL on expires_at)
{
  _id: ObjectId,
  code: string,               // 8-char base32, unique
  email: string,              // lowercased
  invited_by: ObjectId,       // user_id of owner
  expires_at: Date,           // 15 min after issue
  consumed_at: string | null, // single-use
}

// refresh_tokens  (TTL on expires_at)
{
  _id: ObjectId,
  user_id: ObjectId,
  token_hash: string,         // sha256(raw token)
  issued_at: string,
  expires_at: Date,           // 90 days after issue
  revoked_at: string | null,
  replaced_by: ObjectId | null,
  device_label: string,
}

// webauthn_challenges  (TTL on expires_at; 5 min)
{
  _id: ObjectId,
  challenge: string,          // base64url
  purpose: "register" | "authenticate",
  user_id: ObjectId | null,
  email: string | null,
  invite_code: string | null,
  expires_at: Date,
}
```

Indexes:
- `users`: `{ email: 1 }` unique, case-insensitive collation.
- `credentials`: `{ credential_id: 1 }` unique; `{ user_id: 1 }`.
- `invites`: `{ code: 1 }` unique; `{ expires_at: 1 }` TTL.
- `refresh_tokens`: `{ token_hash: 1 }` unique; `{ expires_at: 1 }` TTL; `{ user_id: 1 }`.
- `webauthn_challenges`: `{ expires_at: 1 }` TTL.

## 6. HTTP contract

All paths under `/api/auth`. `(auth)` = requires `requireAuth`; `(owner)` = requires `requireOwner`.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/bootstrap` | — | `{ claimed: boolean }` |
| `POST` | `/register/options` | `{ email, invite_code? }` | `PublicKeyCredentialCreationOptionsJSON` |
| `POST` | `/register/verify` | `{ email, invite_code?, credential, device_label }` | `{ access_token, refresh_token, user }` |
| `POST` | `/login/options` | `{ email }` | `PublicKeyCredentialRequestOptionsJSON` |
| `POST` | `/login/verify` | `{ email, credential }` | `{ access_token, refresh_token, user }` |
| `POST` | `/refresh` | `{ refresh_token }` *(or via `maple_refresh` cookie)* | `{ access_token, refresh_token }` *(also set/rotated as cookie if request used the cookie)* |
| `POST` | `/logout` (auth) | `{ refresh_token? }` *(or via cookie)* | `204` *(clears cookie if present)* |
| `POST` | `/invites` (auth, owner) | `{ email }` | `{ code, expires_at }` |
| `GET` | `/invites` (auth, owner) | — | `[{ email, expires_at, consumed_at }]` |
| `DELETE` | `/invites/:code` (auth, owner) | — | `204` |
| `GET` | `/me` (auth) | — | `{ user, credentials: [{ id, device_label, last_used_at }] }` |
| `POST` | `/credentials/options` (auth) | — | Registration options for current user |
| `POST` | `/credentials/verify` (auth) | `{ credential, device_label }` | `{ credential_id }` |
| `DELETE` | `/credentials/:id` (auth) | — | `204` (refuses if it would remove the user's last credential → `409`) |

Errors:
- `401` — missing / invalid / expired access token.
- `403` — authenticated but lacks role (e.g. member calls `/invites`).
- `409` — last-credential removal, owner self-demotion.
- `410` — invite expired or already consumed.
- `429` — rate limit (see §7).

## 7. Token lifecycle

- **Access token** — JWT, HS256, payload `{ sub, email, role, iat, exp }`, 30-day expiry. Stateless verification on every request.
- **Refresh token** — opaque random 32 bytes, base64url-encoded. Stored hashed (SHA-256) in `refresh_tokens`. 90-day TTL. Rotated on every `/refresh`: the old row is marked `revoked_at` and `replaced_by` points at the new row. **Transport:** Apple sends/receives in the JSON body (Keychain-backed). Web sends/receives via the `maple_refresh` cookie (`httpOnly`, `Secure`, `SameSite=Lax`); the API reads from cookie if present, falls back to body.
- **Theft detection** — if a refresh token whose row already has `revoked_at` is presented, walk the `replaced_by` chain forward and revoke every descendant. Forces all sessions on that device chain to re-authenticate.
- **Rate limiting** — `/login/options`, `/register/options`, `/refresh`: 10 req / IP / minute. Failures logged; sustained failures block the IP for 1 hour.
- **Key rotation** — `MAPLE_JWT_SECRET` is read once at boot. Rotation requires a restart. Future enhancement: accept an array of secrets so old tokens verify during a 30-day grace window.

## 8. Client flows

### 8.1 First-run / claim server (Apple or Web)

1. User selects Self-Hosted source → enters URL.
2. Client calls `GET /api/auth/bootstrap` → `{ claimed: false }`.
3. UI shows "Claim this server".
4. User enters email → client calls `/register/options` (no invite_code).
5. Platform passkey sheet appears → user creates passkey.
6. Client calls `/register/verify` → server marks user as `owner`, returns tokens.
7. Tokens persisted; user lands on main UI.

### 8.2 Sign in (returning user)

1. Client calls `GET /bootstrap` → `{ claimed: true }`.
2. UI shows "Sign in".
3. User enters email → client calls `/login/options` → server returns allowed credentials.
4. Platform passkey sheet appears → user authenticates.
5. Client calls `/login/verify` → tokens returned.

### 8.3 Owner adds a user

1. Owner opens Settings → Users → "Invite user".
2. Enters invitee's email → client calls `POST /invites` → `{ code, expires_at }`.
3. UI displays code + QR encoding `{ url, code }` (15-min countdown).
4. Owner shares the code/QR out-of-band.

### 8.4 Invitee joins

1. Invitee opens Maple → Settings → "Join server" (or scans QR).
2. Enters URL + email + code (or QR pre-fills URL + code).
3. Client calls `/register/options` with `invite_code` → server validates code/email match → returns options.
4. Passkey sheet → `/register/verify` → server consumes invite, creates user as `member`, returns tokens.

### 8.5 Add a second device

1. User on already-paired device opens Settings → Account → "Add another device".
2. Two paths:
   - **Same device:** triggers a second passkey enrollment via `/credentials/options` + `/credentials/verify`.
   - **Cross-device:** generates a short-lived QR encoding `{ url, one_time_link_token }`. Other device scans, hits a tokenized variant of `/credentials/options` (does not require pre-existing session on the new device), enrolls.

   v1 ships the same-device path. Cross-device enrollment is a follow-up.

### 8.6 401 handling (transparent to feature code)

- `AuthenticatedHTTPClient` (Apple) and `auth.interceptor.ts` (web) intercept `401` from `/api/*`.
- Single-flight refresh: concurrent 401s share one `/refresh` call.
- On success: retry the original request once.
- On failure: clear tokens, emit `signedOut`, route to sign-in screen.

### 8.7 Offline behavior (Apple)

- Valid access token + no network → cached thumbnails / previews still render (existing behavior).
- Expired access token + no network → treat as signed-in for cache reads, show "offline" indicator, queue sidecar writes locally; flush gated on successful re-auth.

## 9. Testing

### 9.1 API (`bun test` in `src/api`)

Integration tests against a real MongoDB (no mocks for contract layer, per CLAUDE.md). Use the test helpers from `@simplewebauthn/server` to generate valid attestations/assertions deterministically.

- **Bootstrap:** empty DB → `claimed: false` → first `register/verify` claims as owner → `claimed: true` → second register without invite returns `403`.
- **Invite lifecycle:** create → redeem → second use returns `410` → expired code returns `410`.
- **Login:** register then login; counter increments; `last_used_at` updates; replayed challenge rejected.
- **Refresh rotation:** rotate once → reuse of old token revokes the entire chain (verified by chain-walk).
- **Authorization:** member cannot `POST /invites` (`403`); member cannot `DELETE` another user's credential (`403`); owner can do both.
- **Middleware:** `/api/folders` → `401` without bearer; `401` with expired JWT; `200` with valid one.
- **Credential management:** enroll second passkey → list shows both → remove one OK → removing last returns `409`.

### 9.2 Apple (`swift test` in `Packages/MapleCore`)

- `TokenStoreTests` — Keychain round-trip, per-server scoping, clear on signOut.
- `AuthenticatedHTTPClientTests` — `URLProtocol` fake transport; verify bearer injection; verify single-flight refresh (10 concurrent 401s → 1 refresh → all retry); verify drop-to-signed-out on refresh failure.
- `AuthClientTests` — mock transport with canned WebAuthn options; assert request/response shapes match contract fixture.

Real passkey crypto is device-only; covered by manual QA checklist added to `docs/testing.md`.

### 9.3 Web (`bun run test` in `src/web`)

- `AuthService` — `HttpTestingController` exercises register/login/refresh shapes.
- `auth.interceptor` — single-flight refresh; redirect-to-sign-in on failure.
- `auth.guard` — route protection.

WebDriver E2E does not drive platform authenticators reliably → no E2E passkey tests.

### 9.4 Cross-platform contract

- Single fixture: `src/api/tests/fixtures/auth-contract.json` — every request and response shape.
- API tests assert outputs match the fixture.
- Apple and web tests assert their inputs match the fixture.
- Drift in either direction fails CI.

### 9.5 CI

Add `bun test` in `src/api` to the existing CI workflow alongside Rust + web tests.

## 10. Migration

There is no existing user data — the `UserDoc` collection is scaffolded but unused. The migration is purely additive: new collections, new env var, new routes. Existing self-hosted deployments will see all `/api/*` calls return `401` after upgrade until they sign in (and claim, if first user).

A one-liner in the upgrade notes: "On first launch after upgrade, sign in with the Maple app to claim the server."

## 11. Out of scope (follow-ups)

- Cross-device passkey enrollment via short-lived link.
- Per-user library scoping.
- JWT key rotation with grace window.
- Email-based invite delivery (requires SMTP).
- Audit log of auth events.
- Web push notification of new sign-ins.

## 12. File touch list

**Modify:**
- `src/api/src/routes/auth.ts` — replace stub.
- `src/api/src/db/schema.ts` — replace `UserDoc`, add four new types.
- `src/api/src/db/client.ts` — add indexes (TTL, unique).
- `src/api/src/index.ts` — wire middleware.
- `src/apple/Maple/MapleApp.swift` — inject `AuthSession`.
- `src/apple/Maple/Views/AppShell.swift` — sign-in gate.
- `src/apple/Maple/Views/LibrarySelection.swift`, `LibrarySidebar.swift` — route through `SignInView`.
- `src/apple/Maple/Views/QRScannerView.swift` — handle invite-code QR payload.
- `src/web/projects/maple/src/app/app.routes.ts` — add new routes + guard.
- `.github/workflows/ci.yml` (or equivalent) — add `bun test` step for `src/api`.

**Add:**
- `src/api/src/auth/` (webauthn.ts, tokens.ts, middleware.ts, invites.ts).
- `src/api/tests/auth/*.test.ts`.
- `src/api/tests/fixtures/auth-contract.json`.
- `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/` (4 files).
- `src/apple/Maple/Views/SignInView.swift`, `JoinWithInviteView.swift`, `AccountSettingsView.swift`, `ManageUsersView.swift`.
- `src/web/projects/maple-common/src/lib/auth/` (auth.service.ts, auth.interceptor.ts, auth.guard.ts).
- `src/web/projects/maple/src/app/sign-in/`, `join/`, `settings/account/`, `settings/users/` Angular components.
- `docs/testing.md` — manual passkey QA checklist.

**No-touch:**
- `src/raw-pipeline/**`.
- `docs/sidecar-schema.md`.
- XMP writers in Apple or web.
- Existing thumbnail/cache layers (transparent through `AuthenticatedHTTPClient`).
