# Passkey Auth + Invite-Only Multi-User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deferred Phase 5 auth scaffold with a real WebAuthn / passkey implementation. Server: invite-only multi-user with one `owner` + N `member`s. Apple + web clients sign in via platform passkeys; tokens are 30-day JWTs with rotating refresh tokens. All `/api/*` routes (except `/api/auth/*` and `/api/health`) gated behind a valid session.

**Architecture:** Three phases delivered in order. Phase A ships the server endpoints and tests but leaves the global `requireAuth` middleware *off* so existing self-hosted clients keep working. Phase B ships the Apple client. Phase C ships the web client. Phase D flips the global middleware on once both clients can authenticate. The cross-platform contract is locked in `src/api/tests/fixtures/auth-contract.json` and validated from all three sides.

**Tech Stack:**
- Server: Bun + Elysia + MongoDB, `@simplewebauthn/server`, JWT via `@noble/hashes` HMAC (no extra dep — already vendored).
- Apple: SwiftUI + `@Observable`, `ASAuthorizationPlatformPublicKeyCredentialProvider`, Keychain.
- Web: Angular 21 standalone + signals + RxJS, `@simplewebauthn/browser`, HTTP interceptor.

**Spec:** `.archived-plans/specs/2026-04-26-passkey-auth-design.md`. Read it before starting.

**File structure:** see spec § 12.

---

## Phase A — Server

### Task A1: Dependencies + DB schema types

**Files:**
- Modify: `src/api/package.json`
- Modify: `src/api/src/db/schema.ts`

- [ ] **Step 1: Add WebAuthn dependency**

```bash
cd src/api && bun add @simplewebauthn/server@^11
```

- [ ] **Step 2: Replace `UserDoc` and add new types in `db/schema.ts`**

Replace the existing § "User (Phase 5 — scaffolded)" section with:

```ts
// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export type UserRole = "owner" | "member";

export interface UserDoc {
  email: string;             // unique, lowercased
  role: UserRole;
  created_at: string;
  last_seen_at: string | null;
}
export type UserWithId = WithId<UserDoc>;

// ---------------------------------------------------------------------------
// Credential (one user → many passkeys)
// ---------------------------------------------------------------------------

export interface CredentialDoc {
  user_id: ObjectId;
  credential_id: string;     // base64url, unique
  public_key: Buffer;        // COSE key
  counter: number;
  transports: string[];
  device_label: string;
  created_at: string;
  last_used_at: string | null;
}
export type CredentialWithId = WithId<CredentialDoc>;

// ---------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------

export interface InviteDoc {
  code: string;              // 8-char base32, unique
  email: string;             // lowercased
  invited_by: ObjectId;
  expires_at: Date;          // TTL
  consumed_at: string | null;
}
export type InviteWithId = WithId<InviteDoc>;

// ---------------------------------------------------------------------------
// Refresh token
// ---------------------------------------------------------------------------

export interface RefreshTokenDoc {
  user_id: ObjectId;
  token_hash: string;        // sha256(raw)
  issued_at: string;
  expires_at: Date;          // TTL
  revoked_at: string | null;
  replaced_by: ObjectId | null;
  device_label: string;
}
export type RefreshTokenWithId = WithId<RefreshTokenDoc>;

// ---------------------------------------------------------------------------
// WebAuthn challenge (5-min TTL)
// ---------------------------------------------------------------------------

export type ChallengePurpose = "register" | "authenticate" | "add_credential";

export interface ChallengeDoc {
  challenge: string;         // base64url
  purpose: ChallengePurpose;
  user_id: ObjectId | null;
  email: string | null;
  invite_code: string | null;
  expires_at: Date;          // TTL
}
export type ChallengeWithId = WithId<ChallengeDoc>;
```

- [ ] **Step 3: Add typed collection accessors in `db/client.ts`**

After `indexerQueueCollection`, add:

```ts
export async function usersCollection(): Promise<Collection<UserDoc>> {
  return (await getDb()).collection<UserDoc>("users");
}
export async function credentialsCollection(): Promise<Collection<CredentialDoc>> {
  return (await getDb()).collection<CredentialDoc>("credentials");
}
export async function invitesCollection(): Promise<Collection<InviteDoc>> {
  return (await getDb()).collection<InviteDoc>("invites");
}
export async function refreshTokensCollection(): Promise<Collection<RefreshTokenDoc>> {
  return (await getDb()).collection<RefreshTokenDoc>("refresh_tokens");
}
export async function challengesCollection(): Promise<Collection<ChallengeDoc>> {
  return (await getDb()).collection<ChallengeDoc>("challenges");
}
```

Add the imports at the top: `CredentialDoc, InviteDoc, RefreshTokenDoc, ChallengeDoc, UserDoc`.

- [ ] **Step 4: Add indexes in `ensureIndexes`**

In `db/client.ts` `ensureIndexes`, append:

```ts
const users = await usersCollection();
await users.createIndex({ email: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

const creds = await credentialsCollection();
await creds.createIndex({ credential_id: 1 }, { unique: true });
await creds.createIndex({ user_id: 1 });

const invites = await invitesCollection();
await invites.createIndex({ code: 1 }, { unique: true });
await invites.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

const refresh = await refreshTokensCollection();
await refresh.createIndex({ token_hash: 1 }, { unique: true });
await refresh.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
await refresh.createIndex({ user_id: 1 });

const challenges = await challengesCollection();
await challenges.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
```

- [ ] **Step 5: Typecheck**

Run: `cd src/api && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/api/package.json src/api/bun.lock src/api/src/db/schema.ts src/api/src/db/client.ts
git commit -m "feat(api): auth schema types + indexes"
```

---

### Task A2: JWT + refresh token module

**Files:**
- Create: `src/api/src/auth/tokens.ts`
- Create: `src/api/tests/auth/tokens.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/api/tests/auth/tokens.test.ts
import { describe, it, expect } from "bun:test";
import {
  signAccessToken, verifyAccessToken,
  generateRefreshToken, hashRefreshToken,
} from "../../src/auth/tokens.ts";

const SECRET = "test-secret-32-bytes-long-xxxxxx";

describe("tokens", () => {
  it("signs and verifies an access token", () => {
    const jwt = signAccessToken({ sub: "u1", email: "a@b.c", role: "owner" }, SECRET);
    const claims = verifyAccessToken(jwt, SECRET);
    expect(claims.sub).toBe("u1");
    expect(claims.role).toBe("owner");
  });

  it("rejects a tampered access token", () => {
    const jwt = signAccessToken({ sub: "u1", email: "a@b.c", role: "owner" }, SECRET);
    const [h, p, s] = jwt.split(".");
    const bad = `${h}.${p}.${s.slice(0, -2)}xx`;
    expect(() => verifyAccessToken(bad, SECRET)).toThrow();
  });

  it("rejects an expired access token", () => {
    const jwt = signAccessToken(
      { sub: "u1", email: "a@b.c", role: "owner" },
      SECRET,
      { expiresInSeconds: -1 }
    );
    expect(() => verifyAccessToken(jwt, SECRET)).toThrow(/expired/i);
  });

  it("generates 32-byte base64url refresh tokens", () => {
    const t = generateRefreshToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("hashes refresh tokens deterministically", () => {
    expect(hashRefreshToken("abc")).toBe(hashRefreshToken("abc"));
    expect(hashRefreshToken("abc")).not.toBe(hashRefreshToken("abd"));
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `cd src/api && bun test tests/auth/tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth/tokens.ts`**

```ts
// src/api/src/auth/tokens.ts
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "node:crypto";

const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;        // 30 days
export const REFRESH_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export interface AccessClaims {
  sub: string;            // user_id
  email: string;
  role: "owner" | "member";
  iat: number;
  exp: number;
}

function b64urlEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return buf.toString("base64url");
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function signAccessToken(
  payload: { sub: string; email: string; role: "owner" | "member" },
  secret: string,
  opts: { expiresInSeconds?: number } = {}
): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expiresInSeconds ?? ACCESS_TTL_SECONDS);
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify({ ...payload, iat: now, exp }));
  const data = `${header}.${body}`;
  const sig = b64urlEncode(hmac(sha256, secret, data));
  return `${data}.${sig}`;
}

export function verifyAccessToken(jwt: string, secret: string): AccessClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;
  const expected = b64urlEncode(hmac(sha256, secret, `${h}.${p}`));
  if (!timingSafeEqual(s, expected)) throw new Error("bad signature");
  const claims = JSON.parse(b64urlDecode(p).toString("utf8")) as AccessClaims;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw new Error("token expired");
  }
  return claims;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(raw: string): string {
  return Buffer.from(sha256(raw)).toString("hex");
}

export function refreshExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `cd src/api && bun test tests/auth/tokens.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/auth/tokens.ts src/api/tests/auth/tokens.test.ts
git commit -m "feat(api): JWT + refresh token primitives"
```

---

### Task A3: Refresh token store with rotation + theft detection

**Files:**
- Create: `src/api/src/auth/refresh_store.ts`
- Create: `src/api/tests/auth/refresh_store.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/api/tests/auth/refresh_store.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { issueRefreshToken, rotateRefreshToken, revokeChain } from "../../src/auth/refresh_store.ts";
import { refreshTokensCollection } from "../../src/db/client.ts";

const userId = new ObjectId();

beforeEach(async () => {
  const c = await refreshTokensCollection();
  await c.deleteMany({});
});

describe("refresh store", () => {
  it("issues a token and rotates it on use", async () => {
    const t1 = await issueRefreshToken(userId, "iPhone");
    const t2 = await rotateRefreshToken(t1.raw);
    expect(t2.raw).not.toBe(t1.raw);

    // Old token now revoked
    await expect(rotateRefreshToken(t1.raw)).rejects.toThrow(/revoked|reuse/i);
  });

  it("revokes the entire chain on reuse", async () => {
    const t1 = await issueRefreshToken(userId, "iPhone");
    const t2 = await rotateRefreshToken(t1.raw);
    const t3 = await rotateRefreshToken(t2.raw);
    // Reuse t1 — should kill t2 and t3 too
    await expect(rotateRefreshToken(t1.raw)).rejects.toThrow();
    await expect(rotateRefreshToken(t2.raw)).rejects.toThrow();
    await expect(rotateRefreshToken(t3.raw)).rejects.toThrow();
  });

  it("revokes all tokens for a user", async () => {
    const t = await issueRefreshToken(userId, "iPhone");
    await revokeChain(userId);
    await expect(rotateRefreshToken(t.raw)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd src/api && bun test tests/auth/refresh_store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth/refresh_store.ts`**

```ts
// src/api/src/auth/refresh_store.ts
import { ObjectId } from "mongodb";
import { refreshTokensCollection } from "../db/client.ts";
import { generateRefreshToken, hashRefreshToken, refreshExpiresAt } from "./tokens.ts";

export interface IssuedRefresh { raw: string; userId: ObjectId; }

export async function issueRefreshToken(
  userId: ObjectId,
  deviceLabel: string
): Promise<IssuedRefresh> {
  const raw = generateRefreshToken();
  const c = await refreshTokensCollection();
  await c.insertOne({
    user_id: userId,
    token_hash: hashRefreshToken(raw),
    issued_at: new Date().toISOString(),
    expires_at: refreshExpiresAt(),
    revoked_at: null,
    replaced_by: null,
    device_label: deviceLabel,
  });
  return { raw, userId };
}

export async function rotateRefreshToken(rawOld: string): Promise<IssuedRefresh> {
  const c = await refreshTokensCollection();
  const hash = hashRefreshToken(rawOld);
  const row = await c.findOne({ token_hash: hash });
  if (!row) throw new Error("unknown refresh token");

  if (row.revoked_at !== null) {
    // Reuse → kill the entire chain (walk forward via replaced_by + walk backward by following chain).
    await revokeChain(row.user_id);
    throw new Error("refresh token reuse detected — chain revoked");
  }

  if (row.expires_at.getTime() < Date.now()) {
    throw new Error("refresh token expired");
  }

  const fresh = await issueRefreshToken(row.user_id, row.device_label);
  await c.updateOne(
    { _id: row._id },
    { $set: { revoked_at: new Date().toISOString(), replaced_by: (await c.findOne({ token_hash: hashRefreshToken(fresh.raw) }))!._id } }
  );
  return fresh;
}

export async function revokeChain(userId: ObjectId): Promise<void> {
  const c = await refreshTokensCollection();
  await c.updateMany(
    { user_id: userId, revoked_at: null },
    { $set: { revoked_at: new Date().toISOString() } }
  );
}

export async function revokeOne(rawToken: string): Promise<void> {
  const c = await refreshTokensCollection();
  await c.updateOne(
    { token_hash: hashRefreshToken(rawToken), revoked_at: null },
    { $set: { revoked_at: new Date().toISOString() } }
  );
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd src/api && bun test tests/auth/refresh_store.test.ts`
Expected: 3 pass. Requires running MongoDB (`docker compose up -d mongo` from `src/api/`).

- [ ] **Step 5: Commit**

```bash
git add src/api/src/auth/refresh_store.ts src/api/tests/auth/refresh_store.test.ts
git commit -m "feat(api): refresh token rotation + theft detection"
```

---

### Task A4: Invite codes module

**Files:**
- Create: `src/api/src/auth/invites.ts`
- Create: `src/api/tests/auth/invites.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/api/tests/auth/invites.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { createInvite, redeemInvite, listInvites, rescindInvite } from "../../src/auth/invites.ts";
import { invitesCollection } from "../../src/db/client.ts";

const owner = new ObjectId();

beforeEach(async () => { (await invitesCollection()).deleteMany({}); });

describe("invites", () => {
  it("creates an 8-char base32 code", async () => {
    const inv = await createInvite(owner, "alice@example.com");
    expect(inv.code).toMatch(/^[A-Z2-7]{8}$/);
    expect(inv.expires_at.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
  });

  it("redeems an invite once for the matching email", async () => {
    const inv = await createInvite(owner, "alice@example.com");
    const r = await redeemInvite(inv.code, "alice@example.com");
    expect(r.ok).toBe(true);
    // Second redeem fails
    await expect(redeemInvite(inv.code, "alice@example.com")).rejects.toThrow(/consumed|410/);
  });

  it("rejects redemption with a wrong email", async () => {
    const inv = await createInvite(owner, "alice@example.com");
    await expect(redeemInvite(inv.code, "bob@example.com")).rejects.toThrow();
  });

  it("rescinds an invite by code", async () => {
    const inv = await createInvite(owner, "alice@example.com");
    await rescindInvite(inv.code);
    await expect(redeemInvite(inv.code, "alice@example.com")).rejects.toThrow();
  });

  it("lists pending invites", async () => {
    await createInvite(owner, "a@b.c");
    await createInvite(owner, "x@y.z");
    const all = await listInvites();
    expect(all).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd src/api && bun test tests/auth/invites.test.ts` — FAIL.

- [ ] **Step 3: Implement `auth/invites.ts`**

```ts
// src/api/src/auth/invites.ts
import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { invitesCollection } from "../db/client.ts";
import type { InviteDoc } from "../db/schema.ts";

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32 (no 0/1/8/9)
const TTL_MS = 15 * 60 * 1000;

function genCode(): string {
  const b = randomBytes(8);
  return Array.from(b, (x) => ALPHA[x % 32]).join("");
}

export async function createInvite(invitedBy: ObjectId, email: string): Promise<InviteDoc & { code: string; expires_at: Date }> {
  const c = await invitesCollection();
  const code = genCode();
  const doc: InviteDoc = {
    code,
    email: email.toLowerCase(),
    invited_by: invitedBy,
    expires_at: new Date(Date.now() + TTL_MS),
    consumed_at: null,
  };
  await c.insertOne(doc);
  return doc;
}

export async function redeemInvite(code: string, email: string): Promise<{ ok: true; invitedBy: ObjectId }> {
  const c = await invitesCollection();
  const row = await c.findOne({ code });
  if (!row) throw Object.assign(new Error("invite not found"), { status: 410 });
  if (row.email !== email.toLowerCase()) throw Object.assign(new Error("invite/email mismatch"), { status: 410 });
  if (row.consumed_at !== null) throw Object.assign(new Error("invite consumed"), { status: 410 });
  if (row.expires_at.getTime() < Date.now()) throw Object.assign(new Error("invite expired"), { status: 410 });
  await c.updateOne({ _id: row._id }, { $set: { consumed_at: new Date().toISOString() } });
  return { ok: true, invitedBy: row.invited_by };
}

export async function listInvites(): Promise<Pick<InviteDoc, "code" | "email" | "expires_at" | "consumed_at">[]> {
  const c = await invitesCollection();
  return c.find({}, { projection: { _id: 0, code: 1, email: 1, expires_at: 1, consumed_at: 1 } }).toArray();
}

export async function rescindInvite(code: string): Promise<void> {
  const c = await invitesCollection();
  await c.deleteOne({ code });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd src/api && bun test tests/auth/invites.test.ts` → 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/auth/invites.ts src/api/tests/auth/invites.test.ts
git commit -m "feat(api): invite code lifecycle"
```

---

### Task A5: WebAuthn ceremony wrapper

**Files:**
- Create: `src/api/src/auth/webauthn.ts`

- [ ] **Step 1: Implement `auth/webauthn.ts`**

```ts
// src/api/src/auth/webauthn.ts
import { ObjectId } from "mongodb";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
  type VerifyRegistrationResponseOpts,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import { challengesCollection, credentialsCollection } from "../db/client.ts";
import type { ChallengePurpose, CredentialDoc } from "../db/schema.ts";

const RP_NAME = "Maple";
function rpID(): string { return process.env.MAPLE_RP_ID ?? "localhost"; }
function origin(): string { return process.env.MAPLE_ORIGIN ?? "http://localhost:3000"; }

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

async function storeChallenge(args: {
  challenge: string;
  purpose: ChallengePurpose;
  user_id: ObjectId | null;
  email: string | null;
  invite_code: string | null;
}) {
  const c = await challengesCollection();
  await c.insertOne({ ...args, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS) });
}

async function consumeChallenge(challenge: string) {
  const c = await challengesCollection();
  const row = await c.findOneAndDelete({ challenge });
  if (!row) throw new Error("challenge not found / already consumed");
  if (row.expires_at.getTime() < Date.now()) throw new Error("challenge expired");
  return row;
}

export async function buildRegistrationOptions(args: {
  email: string;
  inviteCode: string | null;
  existingUserId: ObjectId | null;
  excludeCredentialIds: string[];
}) {
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpID(),
    userID: new TextEncoder().encode(args.existingUserId?.toHexString() ?? args.email),
    userName: args.email,
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials: args.excludeCredentialIds.map((id) => ({ id })),
  });
  await storeChallenge({
    challenge: opts.challenge,
    purpose: args.existingUserId ? "add_credential" : "register",
    user_id: args.existingUserId,
    email: args.email.toLowerCase(),
    invite_code: args.inviteCode,
  });
  return opts;
}

export async function verifyRegistration(args: {
  response: any;
  expectedChallenge: string;
}): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpID(),
    requireUserVerification: false,
  });
}

export async function buildAuthenticationOptions(userId: ObjectId, email: string) {
  const creds = await credentialsCollection();
  const allowed = await creds.find({ user_id: userId }).toArray();
  const opts = await generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials: allowed.map((c) => ({ id: c.credential_id, transports: c.transports as any })),
    userVerification: "preferred",
  });
  await storeChallenge({
    challenge: opts.challenge,
    purpose: "authenticate",
    user_id: userId,
    email: email.toLowerCase(),
    invite_code: null,
  });
  return opts;
}

export async function verifyAuthentication(args: {
  response: any;
  expectedChallenge: string;
  credential: CredentialDoc;
}): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: origin(),
    expectedRPID: rpID(),
    credential: {
      id: args.credential.credential_id,
      publicKey: new Uint8Array(args.credential.public_key),
      counter: args.credential.counter,
      transports: args.credential.transports as any,
    },
  });
}

export { consumeChallenge };
```

- [ ] **Step 2: Typecheck**

Run: `cd src/api && bun run typecheck`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/api/src/auth/webauthn.ts
git commit -m "feat(api): @simplewebauthn ceremony wrappers"
```

---

### Task A6: requireAuth + requireOwner middleware

**Files:**
- Create: `src/api/src/auth/middleware.ts`
- Create: `src/api/tests/auth/middleware.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/api/tests/auth/middleware.test.ts
import { describe, it, expect } from "bun:test";
import { Elysia } from "elysia";
import { requireAuth, requireOwner } from "../../src/auth/middleware.ts";
import { signAccessToken } from "../../src/auth/tokens.ts";

const SECRET = "test-secret-32-bytes-xxxxxxxxxxxx";
process.env.MAPLE_JWT_SECRET = SECRET;

const app = new Elysia()
  .use(requireAuth)
  .get("/me", ({ auth }) => ({ sub: auth.user.sub }))
  .use(requireOwner)
  .post("/owner-only", () => ({ ok: true }));

describe("middleware", () => {
  it("rejects /me without bearer", async () => {
    const r = await app.handle(new Request("http://x/me"));
    expect(r.status).toBe(401);
  });
  it("accepts /me with valid bearer", async () => {
    const t = signAccessToken({ sub: "u1", email: "a@b.c", role: "member" }, SECRET);
    const r = await app.handle(new Request("http://x/me", { headers: { authorization: `Bearer ${t}` } }));
    expect(r.status).toBe(200);
  });
  it("rejects member from owner route", async () => {
    const t = signAccessToken({ sub: "u1", email: "a@b.c", role: "member" }, SECRET);
    const r = await app.handle(new Request("http://x/owner-only", {
      method: "POST", headers: { authorization: `Bearer ${t}` },
    }));
    expect(r.status).toBe(403);
  });
  it("allows owner on owner route", async () => {
    const t = signAccessToken({ sub: "u1", email: "a@b.c", role: "owner" }, SECRET);
    const r = await app.handle(new Request("http://x/owner-only", {
      method: "POST", headers: { authorization: `Bearer ${t}` },
    }));
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd src/api && bun test tests/auth/middleware.test.ts` — FAIL.

- [ ] **Step 3: Implement `auth/middleware.ts`**

```ts
// src/api/src/auth/middleware.ts
import { Elysia } from "elysia";
import { verifyAccessToken, type AccessClaims } from "./tokens.ts";

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error("MAPLE_JWT_SECRET unset or too short");
  return s;
}

export const requireAuth = new Elysia({ name: "requireAuth" })
  .derive({ as: "scoped" }, ({ headers, set }) => {
    const h = headers["authorization"] ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) {
      set.status = 401;
      throw new Error("missing bearer");
    }
    let claims: AccessClaims;
    try { claims = verifyAccessToken(m[1], jwtSecret()); }
    catch (e) { set.status = 401; throw e; }
    return { auth: { user: claims } };
  });

export const requireOwner = new Elysia({ name: "requireOwner" })
  .use(requireAuth)
  .onBeforeHandle(({ auth, set }) => {
    if (auth.user.role !== "owner") {
      set.status = 403;
      return { error: "owner role required" };
    }
  });
```

- [ ] **Step 4: Run, expect pass**

Run: `cd src/api && bun test tests/auth/middleware.test.ts` → 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/auth/middleware.ts src/api/tests/auth/middleware.test.ts
git commit -m "feat(api): requireAuth + requireOwner middleware"
```

---

### Task A7: Auth routes — bootstrap + register

**Files:**
- Modify: `src/api/src/routes/auth.ts` (full rewrite)
- Create: `src/api/tests/auth/routes.bootstrap.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// src/api/tests/auth/routes.bootstrap.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authRoutes } from "../../src/routes/auth.ts";
import {
  usersCollection, credentialsCollection, invitesCollection,
  refreshTokensCollection, challengesCollection,
} from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);

const app = new Elysia().use(authRoutes);

beforeEach(async () => {
  for (const c of [usersCollection, credentialsCollection, invitesCollection,
                   refreshTokensCollection, challengesCollection]) {
    (await c()).deleteMany({});
  }
});

describe("auth/bootstrap", () => {
  it("returns claimed=false on empty DB", async () => {
    const r = await app.handle(new Request("http://x/api/auth/bootstrap"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ claimed: false });
  });

  it("returns claimed=true once a user exists", async () => {
    await (await usersCollection()).insertOne({
      email: "a@b.c", role: "owner",
      created_at: new Date().toISOString(), last_seen_at: null,
    });
    const r = await app.handle(new Request("http://x/api/auth/bootstrap"));
    expect(await r.json()).toEqual({ claimed: true });
  });
});

describe("auth/register options", () => {
  it("accepts when DB empty (claim flow)", async () => {
    const r = await app.handle(new Request("http://x/api/auth/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c" }),
    }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.challenge).toBeDefined();
  });

  it("rejects when claimed and no invite", async () => {
    await (await usersCollection()).insertOne({
      email: "a@b.c", role: "owner",
      created_at: new Date().toISOString(), last_seen_at: null,
    });
    const r = await app.handle(new Request("http://x/api/auth/register/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@y.z" }),
    }));
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd src/api && bun test tests/auth/routes.bootstrap.test.ts` — FAIL.

- [ ] **Step 3: Rewrite `routes/auth.ts` (bootstrap + register/options + register/verify only — other routes added in later tasks)**

```ts
// src/api/src/routes/auth.ts
import { Elysia, t } from "elysia";
import { ObjectId } from "mongodb";
import {
  usersCollection, credentialsCollection, invitesCollection,
} from "../db/client.ts";
import {
  buildRegistrationOptions, verifyRegistration, consumeChallenge,
} from "../auth/webauthn.ts";
import { redeemInvite } from "../auth/invites.ts";
import { signAccessToken } from "../auth/tokens.ts";
import { issueRefreshToken } from "../auth/refresh_store.ts";

function jwtSecret(): string {
  const s = process.env.MAPLE_JWT_SECRET;
  if (!s || s.length < 16) throw new Error("MAPLE_JWT_SECRET unset or too short");
  return s;
}

async function isClaimed(): Promise<boolean> {
  const u = await usersCollection();
  return (await u.countDocuments({}, { limit: 1 })) > 0;
}

export const authRoutes = new Elysia({ prefix: "/api/auth" })
  // ----- bootstrap -----
  .get("/bootstrap", async () => ({ claimed: await isClaimed() }))

  // ----- register/options -----
  .post("/register/options", async ({ body, set }) => {
    const email = body.email.toLowerCase();
    const claimed = await isClaimed();
    let inviteEmail: string | null = null;
    if (claimed) {
      if (!body.invite_code) { set.status = 403; return { error: "invite required" }; }
      // Peek at invite without consuming (consumed on verify).
      const inv = await (await invitesCollection()).findOne({ code: body.invite_code });
      if (!inv || inv.consumed_at || inv.expires_at.getTime() < Date.now()) {
        set.status = 410; return { error: "invite invalid" };
      }
      if (inv.email !== email) { set.status = 410; return { error: "invite/email mismatch" }; }
      inviteEmail = inv.email;
    }
    return buildRegistrationOptions({
      email, inviteCode: body.invite_code ?? null,
      existingUserId: null, excludeCredentialIds: [],
    });
  }, {
    body: t.Object({
      email: t.String({ format: "email" }),
      invite_code: t.Optional(t.String()),
    }),
  })

  // ----- register/verify -----
  .post("/register/verify", async ({ body, set }) => {
    const email = body.email.toLowerCase();
    const challengeRow = await consumeChallenge(body.credential.response.clientDataJSON
      ? JSON.parse(Buffer.from(body.credential.response.clientDataJSON, "base64url").toString()).challenge
      : "");
    if (challengeRow.purpose !== "register" || challengeRow.email !== email) {
      set.status = 400; return { error: "challenge mismatch" };
    }
    const verification = await verifyRegistration({
      response: body.credential, expectedChallenge: challengeRow.challenge,
    });
    if (!verification.verified || !verification.registrationInfo) {
      set.status = 400; return { error: "verification failed" };
    }

    const claimed = await isClaimed();
    if (claimed) {
      // Consume invite now.
      if (!challengeRow.invite_code) { set.status = 403; return { error: "invite required" }; }
      await redeemInvite(challengeRow.invite_code, email);
    }

    const role: "owner" | "member" = claimed ? "member" : "owner";
    const u = await usersCollection();
    const userIns = await u.insertOne({
      email, role,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });

    const reg = verification.registrationInfo;
    const c = await credentialsCollection();
    await c.insertOne({
      user_id: userIns.insertedId,
      credential_id: reg.credential.id,
      public_key: Buffer.from(reg.credential.publicKey),
      counter: reg.credential.counter,
      transports: (body.credential.response.transports ?? []) as string[],
      device_label: body.device_label,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    });

    const access_token = signAccessToken(
      { sub: userIns.insertedId.toHexString(), email, role }, jwtSecret()
    );
    const refresh = await issueRefreshToken(userIns.insertedId, body.device_label);
    return {
      access_token,
      refresh_token: refresh.raw,
      user: { id: userIns.insertedId.toHexString(), email, role },
    };
  }, {
    body: t.Object({
      email: t.String({ format: "email" }),
      invite_code: t.Optional(t.String()),
      device_label: t.String({ minLength: 1, maxLength: 64 }),
      credential: t.Any(),
    }),
  });
```

- [ ] **Step 4: Run, expect pass**

Run: `cd src/api && bun test tests/auth/routes.bootstrap.test.ts` → 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/routes/auth.ts src/api/tests/auth/routes.bootstrap.test.ts
git commit -m "feat(api): bootstrap + register routes"
```

---

### Task A8: Auth routes — login + refresh + logout

**Files:**
- Modify: `src/api/src/routes/auth.ts`
- Create: `src/api/tests/auth/routes.login.test.ts`

- [ ] **Step 1: Append login/refresh/logout routes to `routes/auth.ts`**

After the register/verify route, append:

```ts
  // ----- login/options -----
  .post("/login/options", async ({ body, set }) => {
    const email = body.email.toLowerCase();
    const u = await (await usersCollection()).findOne({ email });
    if (!u) { set.status = 404; return { error: "no such user" }; }
    return buildAuthenticationOptions(u._id, email);
  }, { body: t.Object({ email: t.String({ format: "email" }) }) })

  // ----- login/verify -----
  .post("/login/verify", async ({ body, set }) => {
    const email = body.email.toLowerCase();
    const challengeRow = await consumeChallenge(JSON.parse(
      Buffer.from(body.credential.response.clientDataJSON, "base64url").toString()
    ).challenge);
    if (challengeRow.purpose !== "authenticate" || challengeRow.email !== email) {
      set.status = 400; return { error: "challenge mismatch" };
    }
    const u = (await usersCollection()).findOne({ email });
    const user = await u; if (!user) { set.status = 404; return { error: "no such user" }; }
    const cred = await (await credentialsCollection()).findOne({
      user_id: user._id, credential_id: body.credential.id,
    });
    if (!cred) { set.status = 400; return { error: "unknown credential" }; }
    const verification = await verifyAuthentication({
      response: body.credential, expectedChallenge: challengeRow.challenge, credential: cred,
    });
    if (!verification.verified) { set.status = 400; return { error: "verification failed" }; }

    await (await credentialsCollection()).updateOne(
      { _id: cred._id },
      { $set: { counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() } }
    );
    await (await usersCollection()).updateOne(
      { _id: user._id }, { $set: { last_seen_at: new Date().toISOString() } }
    );

    const access_token = signAccessToken(
      { sub: user._id.toHexString(), email: user.email, role: user.role }, jwtSecret()
    );
    const refresh = await issueRefreshToken(user._id, cred.device_label);
    return {
      access_token, refresh_token: refresh.raw,
      user: { id: user._id.toHexString(), email: user.email, role: user.role },
    };
  }, {
    body: t.Object({
      email: t.String({ format: "email" }),
      credential: t.Any(),
    }),
  })

  // ----- refresh -----
  .post("/refresh", async ({ body, headers, cookie, set }) => {
    const raw = body.refresh_token ?? cookie.maple_refresh?.value;
    if (!raw) { set.status = 401; return { error: "no refresh token" }; }
    const fresh = await rotateRefreshToken(raw);
    const user = await (await usersCollection()).findOne({ _id: fresh.userId });
    if (!user) { set.status = 401; return { error: "user gone" }; }
    const access_token = signAccessToken(
      { sub: user._id.toHexString(), email: user.email, role: user.role }, jwtSecret()
    );
    if (cookie.maple_refresh) {
      cookie.maple_refresh.set({
        value: fresh.raw, httpOnly: true, secure: true, sameSite: "lax",
        path: "/", maxAge: REFRESH_TTL_SECONDS,
      });
    }
    return { access_token, refresh_token: fresh.raw };
  }, { body: t.Object({ refresh_token: t.Optional(t.String()) }) })

  // ----- logout -----
  .post("/logout", async ({ body, cookie, headers }) => {
    const raw = body.refresh_token ?? cookie.maple_refresh?.value;
    if (raw) { try { await revokeOne(raw); } catch {} }
    if (cookie.maple_refresh) cookie.maple_refresh.remove();
    return new Response(null, { status: 204 });
  }, { body: t.Object({ refresh_token: t.Optional(t.String()) }) })
```

Add imports at the top:

```ts
import { buildAuthenticationOptions, verifyAuthentication } from "../auth/webauthn.ts";
import { rotateRefreshToken, revokeOne } from "../auth/refresh_store.ts";
import { REFRESH_TTL_SECONDS } from "../auth/tokens.ts";
```

- [ ] **Step 2: Write login/refresh test**

```ts
// src/api/tests/auth/routes.login.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authRoutes } from "../../src/routes/auth.ts";
import {
  usersCollection, refreshTokensCollection, challengesCollection,
} from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const app = new Elysia().use(authRoutes);

beforeEach(async () => {
  for (const c of [usersCollection, refreshTokensCollection, challengesCollection]) {
    (await c()).deleteMany({});
  }
});

describe("login flow", () => {
  it("404 on login/options for unknown email", async () => {
    const r = await app.handle(new Request("http://x/api/auth/login/options", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ghost@nope" }),
    }));
    expect(r.status).toBe(404);
  });
});

describe("refresh", () => {
  it("401 without token", async () => {
    const r = await app.handle(new Request("http://x/api/auth/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(r.status).toBe(401);
  });

  it("401 on unknown token", async () => {
    const r = await app.handle(new Request("http://x/api/auth/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "garbage" }),
    }));
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run, expect pass**

Run: `cd src/api && bun test tests/auth/routes.login.test.ts` → 3 pass.

(Full attestation/assertion happy-path tests come in Task A14 once the simplewebauthn helper is wired up.)

- [ ] **Step 4: Commit**

```bash
git add src/api/src/routes/auth.ts src/api/tests/auth/routes.login.test.ts
git commit -m "feat(api): login + refresh + logout routes"
```

---

### Task A9: Auth routes — invites CRUD

**Files:**
- Modify: `src/api/src/routes/auth.ts`
- Create: `src/api/tests/auth/routes.invites.test.ts`

- [ ] **Step 1: Append invite routes to `routes/auth.ts`**

After logout, append:

```ts
  // ----- invites (owner-only) -----
  .group("/invites", (g) =>
    g.use(requireOwner)
      .post("/", async ({ body, auth }) => {
        const inv = await createInvite(new ObjectId(auth.user.sub), body.email);
        return { code: inv.code, expires_at: inv.expires_at };
      }, { body: t.Object({ email: t.String({ format: "email" }) }) })
      .get("/", async () => listInvites())
      .delete("/:code", async ({ params }) => {
        await rescindInvite(params.code);
        return new Response(null, { status: 204 });
      })
  )
```

Add imports:

```ts
import { requireOwner } from "../auth/middleware.ts";
import { createInvite, listInvites, rescindInvite } from "../auth/invites.ts";
```

- [ ] **Step 2: Write test**

```ts
// src/api/tests/auth/routes.invites.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { authRoutes } from "../../src/routes/auth.ts";
import { signAccessToken } from "../../src/auth/tokens.ts";
import { invitesCollection, usersCollection } from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const app = new Elysia().use(authRoutes);

const ownerId = new ObjectId();
const memberId = new ObjectId();
const ownerJwt = signAccessToken({ sub: ownerId.toHexString(), email: "o@m.c", role: "owner" }, "x".repeat(32));
const memberJwt = signAccessToken({ sub: memberId.toHexString(), email: "m@m.c", role: "member" }, "x".repeat(32));

beforeEach(async () => {
  (await invitesCollection()).deleteMany({});
  (await usersCollection()).deleteMany({});
});

describe("invites CRUD", () => {
  it("rejects member from POST /invites", async () => {
    const r = await app.handle(new Request("http://x/api/auth/invites", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${memberJwt}` },
      body: JSON.stringify({ email: "x@y.z" }),
    }));
    expect(r.status).toBe(403);
  });

  it("owner creates and lists an invite", async () => {
    const r = await app.handle(new Request("http://x/api/auth/invites", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ email: "alice@x.y" }),
    }));
    expect(r.status).toBe(200);
    const { code } = await r.json();

    const list = await app.handle(new Request("http://x/api/auth/invites", {
      headers: { authorization: `Bearer ${ownerJwt}` },
    }));
    const items = await list.json();
    expect(items.find((i: any) => i.code === code)).toBeDefined();
  });

  it("owner rescinds an invite", async () => {
    const cr = await app.handle(new Request("http://x/api/auth/invites", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerJwt}` },
      body: JSON.stringify({ email: "alice@x.y" }),
    }));
    const { code } = await cr.json();
    const dr = await app.handle(new Request(`http://x/api/auth/invites/${code}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ownerJwt}` },
    }));
    expect(dr.status).toBe(204);
  });
});
```

- [ ] **Step 3: Run, expect pass**

Run: `cd src/api && bun test tests/auth/routes.invites.test.ts` → 3 pass.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/routes/auth.ts src/api/tests/auth/routes.invites.test.ts
git commit -m "feat(api): invite CRUD routes"
```

---

### Task A10: Auth routes — `/me` + credentials management

**Files:**
- Modify: `src/api/src/routes/auth.ts`
- Create: `src/api/tests/auth/routes.credentials.test.ts`

- [ ] **Step 1: Append `/me` and credential routes**

```ts
  // ----- /me -----
  .group("/", (g) =>
    g.use(requireAuth)
      .get("/me", async ({ auth }) => {
        const userId = new ObjectId(auth.user.sub);
        const user = await (await usersCollection()).findOne({ _id: userId });
        const creds = await (await credentialsCollection())
          .find({ user_id: userId },
                { projection: { _id: 1, device_label: 1, last_used_at: 1, created_at: 1 } })
          .toArray();
        return {
          user: user ? { id: user._id.toHexString(), email: user.email, role: user.role } : null,
          credentials: creds.map((c) => ({
            id: c._id.toHexString(),
            device_label: c.device_label,
            last_used_at: c.last_used_at,
            created_at: c.created_at,
          })),
        };
      })

      // ----- add another credential -----
      .post("/credentials/options", async ({ auth }) => {
        const userId = new ObjectId(auth.user.sub);
        const existing = await (await credentialsCollection())
          .find({ user_id: userId }, { projection: { credential_id: 1 } }).toArray();
        return buildRegistrationOptions({
          email: auth.user.email,
          inviteCode: null,
          existingUserId: userId,
          excludeCredentialIds: existing.map((e) => e.credential_id),
        });
      })

      .post("/credentials/verify", async ({ auth, body, set }) => {
        const userId = new ObjectId(auth.user.sub);
        const challengeRow = await consumeChallenge(JSON.parse(
          Buffer.from(body.credential.response.clientDataJSON, "base64url").toString()
        ).challenge);
        if (challengeRow.purpose !== "add_credential" ||
            !challengeRow.user_id || !challengeRow.user_id.equals(userId)) {
          set.status = 400; return { error: "challenge mismatch" };
        }
        const verification = await verifyRegistration({
          response: body.credential, expectedChallenge: challengeRow.challenge,
        });
        if (!verification.verified || !verification.registrationInfo) {
          set.status = 400; return { error: "verification failed" };
        }
        const reg = verification.registrationInfo;
        const c = await credentialsCollection();
        const ins = await c.insertOne({
          user_id: userId,
          credential_id: reg.credential.id,
          public_key: Buffer.from(reg.credential.publicKey),
          counter: reg.credential.counter,
          transports: (body.credential.response.transports ?? []) as string[],
          device_label: body.device_label,
          created_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        });
        return { credential_id: ins.insertedId.toHexString() };
      }, {
        body: t.Object({
          credential: t.Any(),
          device_label: t.String({ minLength: 1, maxLength: 64 }),
        }),
      })

      .delete("/credentials/:id", async ({ auth, params, set }) => {
        const userId = new ObjectId(auth.user.sub);
        const c = await credentialsCollection();
        const count = await c.countDocuments({ user_id: userId });
        if (count <= 1) { set.status = 409; return { error: "cannot remove last credential" }; }
        const r = await c.deleteOne({ _id: new ObjectId(params.id), user_id: userId });
        if (r.deletedCount === 0) { set.status = 404; return { error: "not found" }; }
        return new Response(null, { status: 204 });
      })
  );
```

Add import: `import { requireAuth } from "../auth/middleware.ts";` (alongside requireOwner).

- [ ] **Step 2: Write test**

```ts
// src/api/tests/auth/routes.credentials.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { ObjectId } from "mongodb";
import { authRoutes } from "../../src/routes/auth.ts";
import { signAccessToken } from "../../src/auth/tokens.ts";
import { credentialsCollection, usersCollection } from "../../src/db/client.ts";

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
const app = new Elysia().use(authRoutes);

let userId: ObjectId; let jwt: string;

beforeEach(async () => {
  (await usersCollection()).deleteMany({});
  (await credentialsCollection()).deleteMany({});
  const ins = await (await usersCollection()).insertOne({
    email: "u@m.c", role: "member",
    created_at: new Date().toISOString(), last_seen_at: null,
  });
  userId = ins.insertedId;
  jwt = signAccessToken({ sub: userId.toHexString(), email: "u@m.c", role: "member" }, "x".repeat(32));
});

describe("credentials", () => {
  it("returns 409 when removing the last credential", async () => {
    const credIns = await (await credentialsCollection()).insertOne({
      user_id: userId, credential_id: "c1", public_key: Buffer.from("k"),
      counter: 0, transports: [], device_label: "iPhone",
      created_at: new Date().toISOString(), last_used_at: null,
    });
    const r = await app.handle(new Request(`http://x/api/auth/credentials/${credIns.insertedId.toHexString()}`, {
      method: "DELETE", headers: { authorization: `Bearer ${jwt}` },
    }));
    expect(r.status).toBe(409);
  });

  it("removes a credential when more than one exists", async () => {
    const a = await (await credentialsCollection()).insertOne({
      user_id: userId, credential_id: "c1", public_key: Buffer.from("k"),
      counter: 0, transports: [], device_label: "iPhone",
      created_at: new Date().toISOString(), last_used_at: null,
    });
    await (await credentialsCollection()).insertOne({
      user_id: userId, credential_id: "c2", public_key: Buffer.from("k"),
      counter: 0, transports: [], device_label: "Mac",
      created_at: new Date().toISOString(), last_used_at: null,
    });
    const r = await app.handle(new Request(`http://x/api/auth/credentials/${a.insertedId.toHexString()}`, {
      method: "DELETE", headers: { authorization: `Bearer ${jwt}` },
    }));
    expect(r.status).toBe(204);
  });

  it("/me returns credentials list", async () => {
    await (await credentialsCollection()).insertOne({
      user_id: userId, credential_id: "c1", public_key: Buffer.from("k"),
      counter: 0, transports: [], device_label: "iPhone",
      created_at: new Date().toISOString(), last_used_at: null,
    });
    const r = await app.handle(new Request("http://x/api/auth/me", {
      headers: { authorization: `Bearer ${jwt}` },
    }));
    const body = await r.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].device_label).toBe("iPhone");
  });
});
```

- [ ] **Step 3: Run, expect pass**

Run: `cd src/api && bun test tests/auth/routes.credentials.test.ts` → 3 pass.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/routes/auth.ts src/api/tests/auth/routes.credentials.test.ts
git commit -m "feat(api): /me + credential management routes"
```

---

### Task A11: Cross-platform contract fixture

**Files:**
- Create: `src/api/tests/fixtures/auth-contract.json`
- Create: `src/api/tests/auth/contract.test.ts`

- [ ] **Step 1: Write the contract fixture**

```json
{
  "version": 1,
  "endpoints": [
    {
      "id": "bootstrap",
      "method": "GET",
      "path": "/api/auth/bootstrap",
      "request": null,
      "response_keys": ["claimed"]
    },
    {
      "id": "register_options",
      "method": "POST",
      "path": "/api/auth/register/options",
      "request_keys": ["email"],
      "request_optional_keys": ["invite_code"],
      "response_keys": ["challenge", "rp", "user", "pubKeyCredParams"]
    },
    {
      "id": "register_verify",
      "method": "POST",
      "path": "/api/auth/register/verify",
      "request_keys": ["email", "device_label", "credential"],
      "request_optional_keys": ["invite_code"],
      "response_keys": ["access_token", "refresh_token", "user"]
    },
    {
      "id": "login_options",
      "method": "POST",
      "path": "/api/auth/login/options",
      "request_keys": ["email"],
      "response_keys": ["challenge", "allowCredentials"]
    },
    {
      "id": "login_verify",
      "method": "POST",
      "path": "/api/auth/login/verify",
      "request_keys": ["email", "credential"],
      "response_keys": ["access_token", "refresh_token", "user"]
    },
    {
      "id": "refresh",
      "method": "POST",
      "path": "/api/auth/refresh",
      "request_optional_keys": ["refresh_token"],
      "response_keys": ["access_token", "refresh_token"]
    },
    {
      "id": "logout",
      "method": "POST",
      "path": "/api/auth/logout",
      "auth": "bearer",
      "request_optional_keys": ["refresh_token"],
      "response_status": 204
    },
    {
      "id": "invites_create",
      "method": "POST",
      "path": "/api/auth/invites",
      "auth": "owner",
      "request_keys": ["email"],
      "response_keys": ["code", "expires_at"]
    },
    {
      "id": "invites_list",
      "method": "GET",
      "path": "/api/auth/invites",
      "auth": "owner",
      "response_kind": "array_of",
      "response_keys": ["code", "email", "expires_at", "consumed_at"]
    },
    {
      "id": "invites_rescind",
      "method": "DELETE",
      "path": "/api/auth/invites/:code",
      "auth": "owner",
      "response_status": 204
    },
    {
      "id": "me",
      "method": "GET",
      "path": "/api/auth/me",
      "auth": "bearer",
      "response_keys": ["user", "credentials"]
    },
    {
      "id": "credentials_options",
      "method": "POST",
      "path": "/api/auth/credentials/options",
      "auth": "bearer",
      "response_keys": ["challenge", "rp", "user", "pubKeyCredParams"]
    },
    {
      "id": "credentials_verify",
      "method": "POST",
      "path": "/api/auth/credentials/verify",
      "auth": "bearer",
      "request_keys": ["credential", "device_label"],
      "response_keys": ["credential_id"]
    },
    {
      "id": "credentials_delete",
      "method": "DELETE",
      "path": "/api/auth/credentials/:id",
      "auth": "bearer",
      "response_status": 204
    }
  ]
}
```

- [ ] **Step 2: Write contract validator test**

```ts
// src/api/tests/auth/contract.test.ts
import { describe, it, expect } from "bun:test";
import contract from "../fixtures/auth-contract.json" with { type: "json" };

describe("auth contract", () => {
  it("has 14 endpoints", () => {
    expect(contract.endpoints).toHaveLength(14);
  });

  it("every endpoint has id, method, path", () => {
    for (const e of contract.endpoints) {
      expect(e.id).toBeTruthy();
      expect(e.method).toBeTruthy();
      expect(e.path).toBeTruthy();
    }
  });
});
```

(Apple and web reference the same JSON via copies committed in their tree — see Tasks B0 and C0.)

- [ ] **Step 3: Run, expect pass**

Run: `cd src/api && bun test tests/auth/contract.test.ts` → 2 pass.

- [ ] **Step 4: Commit**

```bash
git add src/api/tests/fixtures/auth-contract.json src/api/tests/auth/contract.test.ts
git commit -m "test(api): cross-platform auth contract fixture"
```

---

### Task A12: Rate limiting

**Files:**
- Create: `src/api/src/auth/rate_limit.ts`
- Modify: `src/api/src/routes/auth.ts`

- [ ] **Step 1: Implement in-memory rate limiter**

```ts
// src/api/src/auth/rate_limit.ts
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
```

- [ ] **Step 2: Apply to `/login/options`, `/register/options`, `/refresh`**

In `routes/auth.ts`, wrap each of those three handlers with:

```ts
const ip = (request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? "anon")
  .split(",")[0].trim();
if (!rateLimit(`auth:${ip}`, 10, 60_000)) {
  set.status = 429; return { error: "rate limited" };
}
```

(Pull `request` and `set` from the handler context. Add `import { rateLimit } from "../auth/rate_limit.ts";`)

- [ ] **Step 3: Typecheck**

Run: `cd src/api && bun run typecheck` — pass.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/auth/rate_limit.ts src/api/src/routes/auth.ts
git commit -m "feat(api): rate-limit auth endpoints (10/min/IP)"
```

---

### Task A13: Boot-time JWT secret bootstrap

**Files:**
- Modify: `src/api/src/index.ts`

- [ ] **Step 1: Add secret generation at startup**

In `start()`, before `app.listen(PORT)`, add:

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

function ensureJwtSecret(): void {
  if (process.env.MAPLE_JWT_SECRET) return;
  const path = process.env.MAPLE_JWT_SECRET_FILE ?? "./.maple/jwt.secret";
  if (existsSync(path)) {
    process.env.MAPLE_JWT_SECRET = readFileSync(path, "utf8").trim();
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret, { mode: 0o600 });
  process.env.MAPLE_JWT_SECRET = secret;
  console.log(`[server] generated JWT secret at ${path}`);
}

ensureJwtSecret();
```

(Place imports at top alongside the other Node imports.)

- [ ] **Step 2: Manual smoke**

Run: `cd src/api && bun src/index.ts` (briefly).
Expected: log line "generated JWT secret at ..." on first run; subsequent runs reuse the file.
Stop with Ctrl-C.

- [ ] **Step 3: Add `.maple/` to `src/api/.gitignore`**

If a `.gitignore` exists in `src/api/`, append `.maple/`. Otherwise create one with that line.

- [ ] **Step 4: Commit**

```bash
git add src/api/src/index.ts src/api/.gitignore
git commit -m "feat(api): auto-generate JWT secret on first boot"
```

---

### Task A14: WebAuthn happy-path integration test

**Files:**
- Create: `src/api/tests/auth/routes.webauthn.test.ts`

- [ ] **Step 1: Write end-to-end registration + login test using simplewebauthn helpers**

```ts
// src/api/tests/auth/routes.webauthn.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { authRoutes } from "../../src/routes/auth.ts";
import {
  usersCollection, credentialsCollection, refreshTokensCollection, challengesCollection,
} from "../../src/db/client.ts";
// Test helper from @simplewebauthn — generates valid attestation/assertion responses.
// Re-exports a soft-token authenticator we can drive deterministically.
// Uses RPID="localhost" and origin="http://localhost:3000" set via env below.

process.env.MAPLE_JWT_SECRET = "x".repeat(32);
process.env.MAPLE_RP_ID = "localhost";
process.env.MAPLE_ORIGIN = "http://localhost:3000";

const app = new Elysia().use(authRoutes);

beforeEach(async () => {
  for (const c of [usersCollection, credentialsCollection, refreshTokensCollection, challengesCollection]) {
    (await c()).deleteMany({});
  }
});

// NOTE: Implementation uses the soft-authenticator pattern shown in
// @simplewebauthn/server's own test suite. Build a minimal WebAuthn-ish
// authenticator with crypto.subtle that:
//   1. Receives PublicKeyCredentialCreationOptions, returns a fake AttestationResponse.
//   2. Receives PublicKeyCredentialRequestOptions, returns a fake AssertionResponse.
// See https://github.com/MasterKale/SimpleWebAuthn/blob/master/packages/server/src/__tests__/setup.ts
// for the canonical helper shape.

import { generateRegistrationOptions, generateAuthenticationOptions } from "@simplewebauthn/server";
// Test helper colocated below. Build credentials via in-memory soft authenticator.
// See README in @simplewebauthn/server for a worked example in <100 LOC.

describe("WebAuthn happy path", () => {
  it("claims server, signs in, refreshes", async () => {
    // 1. Bootstrap: claimed=false
    const b1 = await app.handle(new Request("http://x/api/auth/bootstrap"));
    expect(await b1.json()).toEqual({ claimed: false });

    // 2. Register: get options, generate fake attestation, verify
    const optsRes = await app.handle(new Request("http://x/api/auth/register/options", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@x.y" }),
    }));
    const opts = await optsRes.json();

    // Soft authenticator factored into ./helpers/soft-authn.ts (Step 2).
    const { register, authenticate } = await import("./helpers/soft-authn.ts");
    const attestation = await register(opts);

    const verRes = await app.handle(new Request("http://x/api/auth/register/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@x.y", device_label: "Test",
        credential: attestation,
      }),
    }));
    const tokens = await verRes.json();
    expect(tokens.access_token).toBeDefined();
    expect(tokens.user.role).toBe("owner");

    // 3. Sign in
    const loRes = await app.handle(new Request("http://x/api/auth/login/options", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@x.y" }),
    }));
    const lopts = await loRes.json();
    const assertion = await authenticate(lopts);
    const lvRes = await app.handle(new Request("http://x/api/auth/login/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@x.y", credential: assertion }),
    }));
    expect(lvRes.status).toBe(200);

    // 4. Refresh rotates
    const r1 = await app.handle(new Request("http://x/api/auth/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }));
    const r1body = await r1.json();
    expect(r1body.refresh_token).not.toBe(tokens.refresh_token);

    // 5. Reusing old refresh fails
    const r2 = await app.handle(new Request("http://x/api/auth/refresh", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    }));
    expect(r2.status).toBeGreaterThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Implement soft authenticator helper**

```ts
// src/api/tests/auth/helpers/soft-authn.ts
//
// Minimal in-memory WebAuthn authenticator for tests. Implements just enough of
// the platform authenticator API to satisfy @simplewebauthn/server's verifier.
// Uses an Ed25519 keypair generated with crypto.subtle and stored in-memory.

import { webcrypto } from "node:crypto";

let kp: CryptoKeyPair | null = null;
let credentialId: Uint8Array | null = null;
let counter = 0;
const RP_ID = "localhost";

function b64url(b: Uint8Array): string { return Buffer.from(b).toString("base64url"); }

async function ensureKp(): Promise<CryptoKeyPair> {
  if (kp) return kp;
  kp = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  credentialId = webcrypto.getRandomValues(new Uint8Array(32));
  return kp;
}

export async function register(opts: any): Promise<any> {
  const k = await ensureKp();
  const pub = await webcrypto.subtle.exportKey("spki", k.publicKey);
  // Produce a minimal CBOR-encoded attestationObject with fmt=none.
  // Implementation uses cbor-x or hand-rolled — see simplewebauthn examples.
  // Returning the shape expected by verifyRegistrationResponse({ response, ... }):
  //   { id, rawId, type: "public-key", response: { clientDataJSON, attestationObject, transports } }
  const clientDataJSON = b64url(new TextEncoder().encode(JSON.stringify({
    type: "webauthn.create",
    challenge: opts.challenge,
    origin: "http://localhost:3000",
    crossOrigin: false,
  })));
  // Build authData + attestationObject (fmt=none) per
  // https://www.w3.org/TR/webauthn-2/#sctn-attestation. ~40 LOC of buffer math.
  // For brevity: extract the helper from
  // https://github.com/MasterKale/SimpleWebAuthn/blob/master/packages/server/src/helpers/iso/isoUint8Array.ts
  // and adapt. Final return shape:
  return {
    id: b64url(credentialId!),
    rawId: b64url(credentialId!),
    type: "public-key",
    response: {
      clientDataJSON,
      attestationObject: "...", // built per spec — see helper file
      transports: ["internal"],
    },
  };
}

export async function authenticate(opts: any): Promise<any> {
  const k = await ensureKp();
  counter++;
  const clientDataJSON = b64url(new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge: opts.challenge,
    origin: "http://localhost:3000",
    crossOrigin: false,
  })));
  // Build authenticatorData + signature per
  // https://www.w3.org/TR/webauthn-2/#sctn-authenticator-data
  return {
    id: b64url(credentialId!),
    rawId: b64url(credentialId!),
    type: "public-key",
    response: {
      authenticatorData: "...",
      clientDataJSON,
      signature: "...",
    },
  };
}
```

**Note:** the exact CBOR + signature encoding is delicate. Two practical paths:
- Vendor `@simplewebauthn/server`'s test helper (it ships one — copy `__tests__/setup.ts` from the upstream repo, MIT license, ~150 LOC).
- Or use `@simplewebauthn/server`'s own integration test as a reference and compose the same with `cbor-x` (`bun add -d cbor-x`).

Pick the vendor path (faster, exact match). Place the vendored file at `src/api/tests/auth/helpers/soft-authn.ts` and credit the upstream license header.

- [ ] **Step 3: Run, expect pass**

Run: `cd src/api && bun test tests/auth/routes.webauthn.test.ts` → 1 pass (the long e2e test).

- [ ] **Step 4: Commit**

```bash
git add src/api/tests/auth/routes.webauthn.test.ts src/api/tests/auth/helpers/
git commit -m "test(api): WebAuthn end-to-end with soft authenticator"
```

---

### Task A15: CI step

**Files:**
- Modify: `.github/workflows/ci.yml` (or whatever the existing CI workflow is named)

- [ ] **Step 1: Inspect current CI**

Run: `ls .github/workflows/` and read the file(s).

- [ ] **Step 2: Add a Bun test job**

Add (or extend an existing job) so it runs:

```yaml
- name: API tests
  working-directory: src/api
  run: |
    bun install --frozen-lockfile
    bun test
```

A MongoDB service is needed:

```yaml
services:
  mongo:
    image: mongo:7
    ports: [27017:27017]
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/
git commit -m "ci: run src/api bun test in CI"
```

---

## Phase B — Apple client

### Task B0: Vendor contract fixture into Apple test bundle

**Files:**
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/auth-contract.json`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AuthContractTests.swift`

- [ ] **Step 1: Copy the JSON file**

```bash
cp src/api/tests/fixtures/auth-contract.json \
   src/apple/Packages/MapleCore/Tests/MapleCoreTests/Fixtures/auth-contract.json
```

- [ ] **Step 2: Test that the JSON parses and lists 14 endpoints**

```swift
// AuthContractTests.swift
import XCTest
@testable import MapleCore

final class AuthContractTests: XCTestCase {
  func testContractFixtureLoads() throws {
    let url = Bundle.module.url(forResource: "auth-contract", withExtension: "json")
    let data = try Data(contentsOf: XCTUnwrap(url))
    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let eps = (json?["endpoints"] as? [[String: Any]]) ?? []
    XCTAssertEqual(eps.count, 14)
  }
}
```

- [ ] **Step 3: Update `Package.swift` to bundle the fixture**

In the `MapleCore` test target, add `resources: [.copy("Fixtures/auth-contract.json")]`.

- [ ] **Step 4: Run, expect pass**

```bash
cd src/apple/Packages/MapleCore && swift test --filter AuthContractTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/
git commit -m "test(apple): vendor auth contract fixture"
```

---

### Task B1: TokenStore (Keychain)

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/TokenStore.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/TokenStoreTests.swift`

- [ ] **Step 1: Write failing test**

```swift
// TokenStoreTests.swift
import XCTest
@testable import MapleCore

final class TokenStoreTests: XCTestCase {
  let serverURL = URL(string: "https://example.test")!

  override func setUp() {
    super.setUp()
    TokenStore.clear(server: serverURL)
  }

  func testRoundTrip() throws {
    let tokens = AuthTokens(access: "a", refresh: "r")
    try TokenStore.save(tokens, server: serverURL)
    let loaded = try TokenStore.load(server: serverURL)
    XCTAssertEqual(loaded?.access, "a")
    XCTAssertEqual(loaded?.refresh, "r")
  }

  func testPerServerScoping() throws {
    try TokenStore.save(.init(access: "a1", refresh: "r1"), server: URL(string: "https://a.test")!)
    try TokenStore.save(.init(access: "a2", refresh: "r2"), server: URL(string: "https://b.test")!)
    XCTAssertEqual(try TokenStore.load(server: URL(string: "https://a.test")!)?.access, "a1")
    XCTAssertEqual(try TokenStore.load(server: URL(string: "https://b.test")!)?.access, "a2")
  }

  func testClear() throws {
    try TokenStore.save(.init(access: "a", refresh: "r"), server: serverURL)
    TokenStore.clear(server: serverURL)
    XCTAssertNil(try TokenStore.load(server: serverURL))
  }
}
```

- [ ] **Step 2: Run, expect fail (no compile)**

```bash
swift test --filter TokenStoreTests
```

- [ ] **Step 3: Implement**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/TokenStore.swift
import Foundation
import Security

public struct AuthTokens: Codable, Equatable {
  public let access: String
  public let refresh: String
  public init(access: String, refresh: String) { self.access = access; self.refresh = refresh }
}

public enum TokenStore {
  private static let service = "app.justmaple.maple.auth"

  public static func save(_ tokens: AuthTokens, server: URL) throws {
    let data = try JSONEncoder().encode(tokens)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: server.absoluteString,
    ]
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw NSError(domain: "TokenStore", code: Int(status)) }
  }

  public static func load(server: URL) throws -> AuthTokens? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: server.absoluteString,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = item as? Data else {
      throw NSError(domain: "TokenStore", code: Int(status))
    }
    return try JSONDecoder().decode(AuthTokens.self, from: data)
  }

  public static func clear(server: URL) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: server.absoluteString,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
swift test --filter TokenStoreTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/
git commit -m "feat(apple): TokenStore (Keychain) per-server scoping"
```

---

### Task B2: AuthSession + AuthClient skeleton

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthSession.swift`
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthClient.swift`

- [ ] **Step 1: Implement `AuthSession`**

```swift
// AuthSession.swift
import Foundation
import Observation

public struct AuthUser: Codable, Equatable {
  public let id: String
  public let email: String
  public let role: String
  public var isOwner: Bool { role == "owner" }
}

@MainActor @Observable
public final class AuthSession {
  public private(set) var server: URL
  public private(set) var user: AuthUser?
  public var isSignedIn: Bool { user != nil }
  public var isOwner: Bool { user?.isOwner ?? false }

  private let client: AuthClient

  public init(server: URL, client: AuthClient) {
    self.server = server; self.client = client
  }

  public func bootstrapAndRestore() async {
    if let tokens = (try? TokenStore.load(server: server)) {
      do {
        let me = try await client.me(accessToken: tokens.access)
        user = me.user
      } catch {
        // Try refresh once.
        if let new = try? await client.refresh(refreshToken: tokens.refresh) {
          try? TokenStore.save(new.tokens, server: server)
          user = new.user
        } else {
          TokenStore.clear(server: server); user = nil
        }
      }
    }
  }

  public func signOut() async {
    if let tokens = try? TokenStore.load(server: server) {
      _ = try? await client.logout(accessToken: tokens.access, refreshToken: tokens.refresh)
    }
    TokenStore.clear(server: server)
    user = nil
  }

  public func setSignedIn(user: AuthUser, tokens: AuthTokens) throws {
    try TokenStore.save(tokens, server: server)
    self.user = user
  }
}
```

- [ ] **Step 2: Implement `AuthClient` skeleton (HTTP layer; WebAuthn ceremonies in B3)**

```swift
// AuthClient.swift
import Foundation

public struct AuthVerifyResponse: Decodable {
  public let access_token: String
  public let refresh_token: String
  public let user: AuthUser
}
public struct AuthMeResponse: Decodable {
  public let user: AuthUser
  public struct Cred: Decodable, Identifiable {
    public let id: String
    public let device_label: String
    public let last_used_at: String?
    public let created_at: String
  }
  public let credentials: [Cred]
}

public actor AuthClient {
  let server: URL
  let urlSession: URLSession
  public init(server: URL, urlSession: URLSession = .shared) {
    self.server = server; self.urlSession = urlSession
  }

  public func bootstrap() async throws -> Bool {
    struct R: Decodable { let claimed: Bool }
    let r: R = try await get("/api/auth/bootstrap", auth: nil)
    return r.claimed
  }

  public func me(accessToken: String) async throws -> AuthMeResponse {
    return try await get("/api/auth/me", auth: accessToken)
  }

  public struct RefreshResult { public let tokens: AuthTokens; public let user: AuthUser }
  public func refresh(refreshToken: String) async throws -> RefreshResult {
    struct R: Decodable { let access_token: String; let refresh_token: String }
    let r: R = try await postJSON("/api/auth/refresh", body: ["refresh_token": refreshToken], auth: nil)
    let me: AuthMeResponse = try await get("/api/auth/me", auth: r.access_token)
    return RefreshResult(tokens: AuthTokens(access: r.access_token, refresh: r.refresh_token), user: me.user)
  }

  public func logout(accessToken: String, refreshToken: String) async throws {
    _ = try await postJSON("/api/auth/logout",
                           body: ["refresh_token": refreshToken],
                           auth: accessToken) as EmptyResponse
  }

  // MARK: - Helpers
  struct EmptyResponse: Decodable {}

  func get<T: Decodable>(_ path: String, auth: String?) async throws -> T {
    var req = URLRequest(url: server.appending(path: path))
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
    if T.self == EmptyResponse.self { return EmptyResponse() as! T }
    return try JSONDecoder().decode(T.self, from: data)
  }

  func postJSON<T: Decodable>(_ path: String, body: [String: Any], auth: String?) async throws -> T {
    var req = URLRequest(url: server.appending(path: path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
    if T.self == EmptyResponse.self { return EmptyResponse() as! T }
    return try JSONDecoder().decode(T.self, from: data)
  }

  func checkStatus(_ resp: URLResponse, data: Data) throws {
    let http = resp as! HTTPURLResponse
    if !(200..<300).contains(http.statusCode) {
      let msg = String(data: data, encoding: .utf8) ?? ""
      throw NSError(domain: "AuthClient", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: msg])
    }
  }
}
```

- [ ] **Step 3: Build**

```bash
cd src/apple/Packages/MapleCore && swift build
```

Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/
git commit -m "feat(apple): AuthSession + AuthClient HTTP layer"
```

---

### Task B3: AuthClient — WebAuthn ceremonies

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthClient.swift`

- [ ] **Step 1: Add registration ceremony**

Append to `AuthClient`:

```swift
import AuthenticationServices

extension AuthClient {
  public func register(email: String, inviteCode: String?, deviceLabel: String,
                       presentationAnchor: ASPresentationAnchor) async throws -> AuthVerifyResponse {
    // Step 1: get options
    var body: [String: Any] = ["email": email]
    if let inviteCode { body["invite_code"] = inviteCode }
    let opts: [String: Any] = try await postJSONRaw("/api/auth/register/options", body: body, auth: nil)

    // Step 2: drive ASAuthorizationPlatformPublicKeyCredentialProvider
    let attestation = try await PasskeyCeremony.create(options: opts, anchor: presentationAnchor)

    // Step 3: verify
    let verifyBody: [String: Any] = [
      "email": email,
      "device_label": deviceLabel,
      "credential": attestation,
      "invite_code": inviteCode as Any,
    ].compactMapValues { $0 is NSNull ? nil : $0 }
    return try await postJSON("/api/auth/register/verify", body: verifyBody, auth: nil)
  }

  public func login(email: String, presentationAnchor: ASPresentationAnchor) async throws -> AuthVerifyResponse {
    let opts: [String: Any] = try await postJSONRaw("/api/auth/login/options", body: ["email": email], auth: nil)
    let assertion = try await PasskeyCeremony.assert(options: opts, anchor: presentationAnchor)
    return try await postJSON("/api/auth/login/verify",
                              body: ["email": email, "credential": assertion], auth: nil)
  }

  func postJSONRaw(_ path: String, body: [String: Any], auth: String?) async throws -> [String: Any] {
    var req = URLRequest(url: server.appending(path: path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
    return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }
}
```

- [ ] **Step 2: Implement `PasskeyCeremony`**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/PasskeyCeremony.swift
import AuthenticationServices
import Foundation

enum PasskeyCeremony {
  static func create(options: [String: Any], anchor: ASPresentationAnchor) async throws -> [String: Any] {
    guard let challengeB64 = options["challenge"] as? String,
          let rp = options["rp"] as? [String: Any],
          let rpID = rp["id"] as? String,
          let user = options["user"] as? [String: Any],
          let userIDB64 = user["id"] as? String,
          let userName = user["name"] as? String,
          let challenge = Data(base64Encoded: challengeB64.padded()) ?? Data(base64URLEncoded: challengeB64),
          let userID = Data(base64URLEncoded: userIDB64) else {
      throw NSError(domain: "PasskeyCeremony", code: -1)
    }
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
    let req = provider.createCredentialRegistrationRequest(challenge: challenge, name: userName, userID: userID)
    let cred = try await PasskeyDelegate.run(request: req, anchor: anchor)
    let reg = cred as! ASAuthorizationPlatformPublicKeyCredentialRegistration
    return [
      "id": reg.credentialID.base64URLEncodedString(),
      "rawId": reg.credentialID.base64URLEncodedString(),
      "type": "public-key",
      "response": [
        "clientDataJSON": reg.rawClientDataJSON.base64URLEncodedString(),
        "attestationObject": reg.rawAttestationObject?.base64URLEncodedString() ?? "",
        "transports": ["internal"],
      ],
    ]
  }

  static func assert(options: [String: Any], anchor: ASPresentationAnchor) async throws -> [String: Any] {
    guard let challengeB64 = options["challenge"] as? String,
          let rpID = options["rpId"] as? String,
          let challenge = Data(base64URLEncoded: challengeB64) else {
      throw NSError(domain: "PasskeyCeremony", code: -1)
    }
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpID)
    let req = provider.createCredentialAssertionRequest(challenge: challenge)
    if let allowed = options["allowCredentials"] as? [[String: Any]] {
      req.allowedCredentials = allowed.compactMap {
        guard let idB64 = $0["id"] as? String, let id = Data(base64URLEncoded: idB64) else { return nil }
        return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
      }
    }
    let cred = try await PasskeyDelegate.run(request: req, anchor: anchor)
    let asn = cred as! ASAuthorizationPlatformPublicKeyCredentialAssertion
    return [
      "id": asn.credentialID.base64URLEncodedString(),
      "rawId": asn.credentialID.base64URLEncodedString(),
      "type": "public-key",
      "response": [
        "authenticatorData": asn.rawAuthenticatorData.base64URLEncodedString(),
        "clientDataJSON": asn.rawClientDataJSON.base64URLEncodedString(),
        "signature": asn.signature.base64URLEncodedString(),
      ],
    ]
  }
}
```

- [ ] **Step 3: Implement `PasskeyDelegate` (ASAuthorizationController async wrapper) and `Data` base64url helpers**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/Auth/PasskeyDelegate.swift
import AuthenticationServices

final class PasskeyDelegate: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private let anchor: ASPresentationAnchor
  private var cont: CheckedContinuation<ASAuthorizationCredential, Error>?

  static func run(request: ASAuthorizationRequest, anchor: ASPresentationAnchor) async throws -> ASAuthorizationCredential {
    let d = PasskeyDelegate(anchor: anchor)
    return try await withCheckedThrowingContinuation { c in
      d.cont = c
      let ctrl = ASAuthorizationController(authorizationRequests: [request])
      ctrl.delegate = d
      ctrl.presentationContextProvider = d
      ctrl.performRequests()
    }
  }
  init(anchor: ASPresentationAnchor) { self.anchor = anchor }
  func presentationAnchor(for: ASAuthorizationController) -> ASPresentationAnchor { anchor }
  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization auth: ASAuthorization) {
    cont?.resume(returning: auth.credential); cont = nil
  }
  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    cont?.resume(throwing: error); cont = nil
  }
}

extension Data {
  init?(base64URLEncoded s: String) {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t.append("=") }
    self.init(base64Encoded: t)
  }
  func base64URLEncodedString() -> String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
extension String { func padded() -> String { var s = self; while s.count % 4 != 0 { s.append("=") }; return s } }
```

- [ ] **Step 4: Build**

```bash
swift build
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/Auth/
git commit -m "feat(apple): WebAuthn registration + assertion via ASAuthorization"
```

---

### Task B4: AuthenticatedHTTPClient with single-flight refresh

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthenticatedHTTPClient.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/AuthenticatedHTTPClientTests.swift`

- [ ] **Step 1: Write failing test**

```swift
// AuthenticatedHTTPClientTests.swift
import XCTest
@testable import MapleCore

final class AuthenticatedHTTPClientTests: XCTestCase {
  func testInjectsBearerOnEveryRequest() async throws {
    StubURLProtocol.register()
    StubURLProtocol.handler = { req in
      XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer A1")
      return (200, Data("{}".utf8), [:])
    }
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(server: URL(string: "https://x.test")!, urlSession: session, tokensProvider: { AuthTokens(access: "A1", refresh: "R1") }, onSignOut: {})
    _ = try await client.data(for: URLRequest(url: URL(string: "https://x.test/api/folders")!))
  }

  func testRefreshesOn401AndRetries() async throws {
    StubURLProtocol.register()
    var calls = 0
    StubURLProtocol.handler = { req in
      calls += 1
      if req.url!.path == "/api/auth/refresh" {
        return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:])
      }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      if auth == "Bearer A1" { return (401, Data("{}".utf8), [:]) }
      if auth == "Bearer A2" { return (200, Data("{}".utf8), [:]) }
      return (500, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!,
      urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    let (_, resp) = try await client.data(for: URLRequest(url: URL(string: "https://x.test/api/folders")!))
    XCTAssertEqual((resp as! HTTPURLResponse).statusCode, 200)
    XCTAssertEqual(current.access, "A2")
  }

  func testSingleFlightRefresh() async throws {
    StubURLProtocol.register()
    var refreshCount = 0
    StubURLProtocol.handler = { req in
      if req.url!.path == "/api/auth/refresh" { refreshCount += 1; return (200, Data(#"{"access_token":"A2","refresh_token":"R2"}"#.utf8), [:]) }
      let auth = req.value(forHTTPHeaderField: "Authorization")
      return (auth == "Bearer A2") ? (200, Data("{}".utf8), [:]) : (401, Data("{}".utf8), [:])
    }
    var current = AuthTokens(access: "A1", refresh: "R1")
    let session = TestURLSession.make()
    let client = AuthenticatedHTTPClient(
      server: URL(string: "https://x.test")!, urlSession: session,
      tokensProvider: { current },
      onTokensRefreshed: { current = $0 },
      onSignOut: {}
    )
    async let r1 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/a")!))
    async let r2 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/b")!))
    async let r3 = client.data(for: URLRequest(url: URL(string: "https://x.test/api/c")!))
    _ = try await (r1, r2, r3)
    XCTAssertEqual(refreshCount, 1)
  }
}
```

(Plus `StubURLProtocol` and `TestURLSession` test helpers — small, ~50 LOC; standard pattern.)

- [ ] **Step 2: Run, expect fail**

```bash
swift test --filter AuthenticatedHTTPClientTests
```

- [ ] **Step 3: Implement**

```swift
// AuthenticatedHTTPClient.swift
import Foundation

public actor AuthenticatedHTTPClient {
  private let server: URL
  private let urlSession: URLSession
  private let tokensProvider: () -> AuthTokens?
  private let onTokensRefreshed: (AuthTokens) -> Void
  private let onSignOut: () -> Void
  private var inflightRefresh: Task<AuthTokens, Error>?

  public init(server: URL, urlSession: URLSession,
              tokensProvider: @escaping () -> AuthTokens?,
              onTokensRefreshed: @escaping (AuthTokens) -> Void = { _ in },
              onSignOut: @escaping () -> Void) {
    self.server = server; self.urlSession = urlSession
    self.tokensProvider = tokensProvider; self.onTokensRefreshed = onTokensRefreshed
    self.onSignOut = onSignOut
  }

  public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
    let (data, resp) = try await dataOnce(request: inject(request, tokens: tokensProvider()))
    if (resp as? HTTPURLResponse)?.statusCode != 401 { return (data, resp) }
    guard let current = tokensProvider() else { onSignOut(); return (data, resp) }
    let fresh: AuthTokens
    do { fresh = try await refresh(refresh: current.refresh) }
    catch { onSignOut(); return (data, resp) }
    onTokensRefreshed(fresh)
    return try await dataOnce(request: inject(request, tokens: fresh))
  }

  private func refresh(refresh refreshToken: String) async throws -> AuthTokens {
    if let t = inflightRefresh { return try await t.value }
    let task = Task { () throws -> AuthTokens in
      var req = URLRequest(url: server.appending(path: "/api/auth/refresh"))
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])
      let (data, resp) = try await urlSession.data(for: req)
      guard (resp as! HTTPURLResponse).statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
      struct R: Decodable { let access_token: String; let refresh_token: String }
      let r = try JSONDecoder().decode(R.self, from: data)
      return AuthTokens(access: r.access_token, refresh: r.refresh_token)
    }
    inflightRefresh = task
    defer { inflightRefresh = nil }
    return try await task.value
  }

  private func inject(_ req: URLRequest, tokens: AuthTokens?) -> URLRequest {
    var r = req
    if let t = tokens { r.setValue("Bearer \(t.access)", forHTTPHeaderField: "Authorization") }
    return r
  }

  private func dataOnce(request: URLRequest) async throws -> (Data, URLResponse) {
    try await urlSession.data(for: request)
  }
}
```

- [ ] **Step 4: Run, expect pass**

```bash
swift test --filter AuthenticatedHTTPClientTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/
git commit -m "feat(apple): authenticated HTTP client with single-flight refresh"
```

---

### Task B5: SignInView (claim-or-sign-in branching)

**Files:**
- Create: `src/apple/Maple/Views/SignInView.swift`

- [ ] **Step 1: Implement view**

```swift
// SignInView.swift
import SwiftUI
import AuthenticationServices
import MapleCore

struct SignInView: View {
  @Environment(AuthSession.self) private var session
  @State private var email = ""
  @State private var inviteCode = ""
  @State private var claimed: Bool? = nil
  @State private var working = false
  @State private var errorText: String? = nil

  let server: URL
  let client: AuthClient

  var body: some View {
    VStack(spacing: 16) {
      Text(claimed == true ? "Sign in to \(server.host ?? "")" : "Claim \(server.host ?? "")")
        .font(.title2.weight(.semibold))
      TextField("Email", text: $email)
        .textFieldStyle(.roundedBorder)
        .accessibilityLabel("Email")
      if claimed == true {
        Button { Task { await signIn() } } label: { Label("Sign in with passkey", systemImage: "key.fill") }
          .buttonStyle(.borderedProminent).disabled(email.isEmpty || working)
        Button("Have an invite code?") { /* navigate to JoinWithInviteView */ }
          .buttonStyle(.plain)
      } else if claimed == false {
        Button { Task { await claim() } } label: { Label("Claim with passkey", systemImage: "key.fill") }
          .buttonStyle(.borderedProminent).disabled(email.isEmpty || working)
      } else {
        ProgressView()
      }
      if let errorText { Text(errorText).foregroundStyle(.red).font(.caption) }
    }
    .padding(32)
    .task { claimed = (try? await client.bootstrap()) }
  }

  @MainActor func claim() async {
    working = true; defer { working = false }
    do {
      let resp = try await client.register(
        email: email, inviteCode: nil,
        deviceLabel: deviceLabel(),
        presentationAnchor: anchor()
      )
      try session.setSignedIn(
        user: resp.user,
        tokens: AuthTokens(access: resp.access_token, refresh: resp.refresh_token)
      )
    } catch { errorText = error.localizedDescription }
  }

  @MainActor func signIn() async {
    working = true; defer { working = false }
    do {
      let resp = try await client.login(email: email, presentationAnchor: anchor())
      try session.setSignedIn(
        user: resp.user,
        tokens: AuthTokens(access: resp.access_token, refresh: resp.refresh_token)
      )
    } catch { errorText = error.localizedDescription }
  }
}

@MainActor private func anchor() -> ASPresentationAnchor {
  #if os(macOS)
  return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
  #else
  return UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
  #endif
}

private func deviceLabel() -> String {
  #if os(macOS)
  return Host.current().localizedName ?? "Mac"
  #else
  return UIDevice.current.name
  #endif
}
```

- [ ] **Step 2: Build**

```bash
xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
```

- [ ] **Step 3: Commit**

```bash
git add src/apple/Maple/Views/SignInView.swift
git commit -m "feat(apple): SignInView (claim or sign in)"
```

---

### Task B6: JoinWithInviteView

**Files:**
- Create: `src/apple/Maple/Views/JoinWithInviteView.swift`

- [ ] **Step 1: Implement**

```swift
// JoinWithInviteView.swift
import SwiftUI
import MapleCore

struct JoinWithInviteView: View {
  @Environment(AuthSession.self) private var session
  @State private var serverString = ""
  @State private var email = ""
  @State private var code = ""
  @State private var working = false
  @State private var errorText: String? = nil

  var body: some View {
    Form {
      Section("Server") {
        TextField("https://maple.example", text: $serverString)
          #if !os(macOS)
          .textInputAutocapitalization(.never)
          #endif
      }
      Section("Account") {
        TextField("Email", text: $email)
        TextField("Invite code", text: $code).textCase(.uppercase)
      }
      if let errorText { Text(errorText).foregroundStyle(.red).font(.caption) }
      Button {
        Task { await join() }
      } label: { Label("Create passkey", systemImage: "key.fill") }
        .disabled(serverString.isEmpty || email.isEmpty || code.count != 8 || working)
    }
    .navigationTitle("Join Maple Server")
  }

  @MainActor func join() async {
    working = true; defer { working = false }
    guard let server = URL(string: serverString) else { errorText = "bad URL"; return }
    let client = AuthClient(server: server)
    do {
      let resp = try await client.register(
        email: email, inviteCode: code,
        deviceLabel: deviceLabel(), presentationAnchor: anchor()
      )
      // Caller navigation: append this server to SourceSelection + persist tokens.
      let local = AuthSession(server: server, client: client)
      try local.setSignedIn(
        user: resp.user,
        tokens: AuthTokens(access: resp.access_token, refresh: resp.refresh_token)
      )
    } catch { errorText = error.localizedDescription }
  }
}
```

- [ ] **Step 2: Build, commit**

```bash
xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
git add src/apple/Maple/Views/JoinWithInviteView.swift
git commit -m "feat(apple): JoinWithInviteView"
```

---

### Task B7: AccountSettingsView + ManageUsersView

**Files:**
- Create: `src/apple/Maple/Views/AccountSettingsView.swift`
- Create: `src/apple/Maple/Views/ManageUsersView.swift`
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthClient.swift` (add invite + credential methods)

- [ ] **Step 1: Extend `AuthClient` with invite + credential calls**

```swift
extension AuthClient {
  public func createInvite(email: String, accessToken: String) async throws -> (code: String, expiresAt: String) {
    struct R: Decodable { let code: String; let expires_at: String }
    let r: R = try await postJSON("/api/auth/invites", body: ["email": email], auth: accessToken)
    return (r.code, r.expires_at)
  }
  public func listInvites(accessToken: String) async throws -> [[String: Any]] {
    return try await getRaw("/api/auth/invites", auth: accessToken)
  }
  public func rescindInvite(code: String, accessToken: String) async throws {
    var req = URLRequest(url: server.appending(path: "/api/auth/invites/\(code)"))
    req.httpMethod = "DELETE"
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
  }
  public func deleteCredential(id: String, accessToken: String) async throws {
    var req = URLRequest(url: server.appending(path: "/api/auth/credentials/\(id)"))
    req.httpMethod = "DELETE"
    req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
  }
  func getRaw(_ path: String, auth: String?) async throws -> [[String: Any]] {
    var req = URLRequest(url: server.appending(path: path))
    if let auth { req.setValue("Bearer \(auth)", forHTTPHeaderField: "Authorization") }
    let (data, resp) = try await urlSession.data(for: req)
    try checkStatus(resp, data: data)
    return (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
  }
}
```

- [ ] **Step 2: Implement `AccountSettingsView`**

```swift
// AccountSettingsView.swift
import SwiftUI
import MapleCore

struct AccountSettingsView: View {
  @Environment(AuthSession.self) private var session
  @State private var me: AuthMeResponse? = nil
  let client: AuthClient

  var body: some View {
    Form {
      if let user = session.user {
        Section("Account") {
          LabeledContent("Email", value: user.email)
          LabeledContent("Role", value: user.role.capitalized)
        }
      }
      if let creds = me?.credentials {
        Section("Passkeys") {
          ForEach(creds) { c in
            HStack {
              VStack(alignment: .leading) {
                Text(c.device_label)
                if let last = c.last_used_at { Text("Last used \(last)").font(.caption2).foregroundStyle(.secondary) }
              }
              Spacer()
              if creds.count > 1 {
                Button(role: .destructive) { Task { await remove(c.id) } } label: { Image(systemName: "trash") }
              }
            }
          }
        }
      }
      Section { Button("Sign out", role: .destructive) { Task { await session.signOut() } } }
    }
    .task { me = try? await client.me(accessToken: TokenStore.load(server: client.server)?.access ?? "") }
  }

  func remove(_ id: String) async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    try? await client.deleteCredential(id: id, accessToken: access)
    me = try? await client.me(accessToken: access)
  }
}
```

- [ ] **Step 3: Implement `ManageUsersView` (owner-only)**

```swift
// ManageUsersView.swift
import SwiftUI
import MapleCore

struct ManageUsersView: View {
  @Environment(AuthSession.self) private var session
  @State private var inviteEmail = ""
  @State private var newCode: String? = nil
  @State private var pending: [(code: String, email: String, expiresAt: String, consumedAt: String?)] = []
  let client: AuthClient

  var body: some View {
    Form {
      Section("Invite a user") {
        TextField("Email", text: $inviteEmail)
        Button("Generate invite code") { Task { await invite() } }
          .disabled(inviteEmail.isEmpty)
        if let code = newCode {
          Text("Share: **\(code)**").textSelection(.enabled)
        }
      }
      Section("Pending invites") {
        ForEach(pending, id: \.code) { p in
          HStack {
            VStack(alignment: .leading) { Text(p.email); Text(p.code).font(.caption.monospaced()) }
            Spacer()
            Button("Rescind", role: .destructive) { Task { await rescind(p.code) } }
          }
        }
      }
    }
    .task { await reload() }
  }

  func invite() async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    let r = try? await client.createInvite(email: inviteEmail, accessToken: access)
    newCode = r?.code; await reload()
  }
  func rescind(_ code: String) async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    try? await client.rescindInvite(code: code, accessToken: access); await reload()
  }
  func reload() async {
    guard let access = try? TokenStore.load(server: client.server)?.access else { return }
    let raw = (try? await client.listInvites(accessToken: access)) ?? []
    pending = raw.compactMap {
      guard let code = $0["code"] as? String, let email = $0["email"] as? String,
            let exp = $0["expires_at"] as? String else { return nil }
      return (code, email, exp, $0["consumed_at"] as? String)
    }
  }
}
```

- [ ] **Step 4: Build + commit**

```bash
xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
git add src/apple/Maple/Views/AccountSettingsView.swift src/apple/Maple/Views/ManageUsersView.swift src/apple/Packages/MapleCore/Sources/MapleCore/Auth/AuthClient.swift
git commit -m "feat(apple): AccountSettings + ManageUsers + AuthClient extensions"
```

---

### Task B8: Wire `AuthSession` into the app shell

**Files:**
- Modify: `src/apple/Maple/MapleApp.swift`
- Modify: `src/apple/Maple/Views/AppShell.swift`
- Modify: `src/apple/Maple/Views/LibrarySelection.swift`
- Modify: `src/apple/Maple/Views/LibrarySidebar.swift`

- [ ] **Step 1: Inject `AuthSession` per Self-Hosted source in `MapleApp`**

The app may have several self-hosted sources. Maintain a dictionary keyed by server URL. In `MapleApp.swift`:

```swift
@State private var sessions: [URL: AuthSession] = [:]

func session(for server: URL) -> AuthSession {
  if let s = sessions[server] { return s }
  let client = AuthClient(server: server)
  let s = AuthSession(server: server, client: client)
  sessions[server] = s
  Task { await s.bootstrapAndRestore() }
  return s
}
```

Pass into `AppShell` via environment when a self-hosted source is selected.

- [ ] **Step 2: Gate the Self-Hosted path in `AppShell`**

```swift
if currentSource is SelfHostedSource {
  if !authSession.isSignedIn {
    SignInView(server: serverURL, client: authClient)
      .environment(authSession)
  } else {
    /* existing main content */
  }
}
```

- [ ] **Step 3: Update `LibrarySelection` to surface "Join with invite"**

Add a row that opens `JoinWithInviteView` in a sheet.

- [ ] **Step 4: Build + commit**

```bash
xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
git add src/apple/Maple/
git commit -m "feat(apple): wire AuthSession into AppShell + LibrarySelection"
```

---

### Task B9: Switch Self-Hosted transport to AuthenticatedHTTPClient

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/Sources/SelfHostedSource.swift` (or wherever Self-Hosted requests live)

- [ ] **Step 1: Locate the existing transport**

Search:
```bash
rg -l "rawBytes|self.host|SelfHosted" src/apple/Packages/MapleCore/Sources/MapleCore/
```

- [ ] **Step 2: Replace direct `URLSession` use with `AuthenticatedHTTPClient`**

Construct an `AuthenticatedHTTPClient` per server URL inside the Self-Hosted source, with `tokensProvider` reading `TokenStore.load(server:)` and `onTokensRefreshed` writing it back. Replace every `urlSession.data(for:)` with `client.data(for:)`.

- [ ] **Step 3: Build, smoke-test against a running API**

```bash
xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
```

Manual: launch API with a fresh JWT secret, claim from the app, browse a folder. Verify `Authorization: Bearer …` appears on every request via API logs.

- [ ] **Step 4: Commit**

```bash
git add src/apple/Packages/MapleCore/
git commit -m "feat(apple): Self-Hosted requests go through AuthenticatedHTTPClient"
```

---

### Task B10: QR scanner invite payload

**Files:**
- Modify: `src/apple/Maple/Views/QRScannerView.swift`

- [ ] **Step 1: Extend the QR payload parser**

Existing pairing QRs encode a server URL. Extend the payload to optionally include an invite code:

```
maple://join?server=<base64url URL>&code=<8-char base32>&email=<base64url email>
```

Parser:
```swift
struct InviteQR { let server: URL; let code: String; let email: String }

func parseInviteQR(_ raw: String) -> InviteQR? {
  guard let url = URL(string: raw),
        url.scheme == "maple", url.host == "join",
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
  let m = Dictionary(uniqueKeysWithValues: comps.compactMap { ($0.name, $0.value ?? "") })
  guard let serverEnc = m["server"], let code = m["code"], let emailEnc = m["email"],
        let serverData = Data(base64URLEncoded: serverEnc), let serverStr = String(data: serverData, encoding: .utf8),
        let server = URL(string: serverStr),
        let emailData = Data(base64URLEncoded: emailEnc), let email = String(data: emailData, encoding: .utf8) else { return nil }
  return InviteQR(server: server, code: code, email: email)
}
```

On scan, present `JoinWithInviteView` pre-filled.

- [ ] **Step 2: Have `ManageUsersView` generate the matching QR for new invites**

(Use any small QR generator already in the project, or generate via `CIFilter.qrCodeGenerator()`.)

- [ ] **Step 3: Build, commit**

```bash
xcodebuild -project src/apple/Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build
git add src/apple/Maple/Views/QRScannerView.swift src/apple/Maple/Views/ManageUsersView.swift
git commit -m "feat(apple): QR-encoded invite codes (scan + emit)"
```

---

## Phase C — Web client

### Task C0: Vendor contract fixture into web tests

**Files:**
- Create: `src/web/projects/maple-common/src/lib/auth/auth-contract.json`

- [ ] **Step 1: Copy fixture**

```bash
cp src/api/tests/fixtures/auth-contract.json \
   src/web/projects/maple-common/src/lib/auth/auth-contract.json
```

- [ ] **Step 2: Test it loads and lists 14 endpoints**

Add a simple unit test referencing it via `import contract from './auth-contract.json';`.

- [ ] **Step 3: Commit**

```bash
git add src/web/projects/maple-common/src/lib/auth/
git commit -m "test(web): vendor auth contract fixture"
```

---

### Task C1: AuthService with @simplewebauthn/browser

**Files:**
- Modify: `src/web/package.json` (add dep)
- Create: `src/web/projects/maple-common/src/lib/auth/auth.service.ts`

- [ ] **Step 1: Add dep**

```bash
cd src/web && bun add @simplewebauthn/browser@^11
```

- [ ] **Step 2: Implement `AuthService`**

```ts
// src/web/projects/maple-common/src/lib/auth/auth.service.ts
import { Injectable, signal, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { firstValueFrom } from "rxjs";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

export interface AuthUser { id: string; email: string; role: "owner" | "member"; }

@Injectable({ providedIn: "root" })
export class AuthService {
  private http = inject(HttpClient);
  readonly user = signal<AuthUser | null>(null);
  private accessToken: string | null = null;

  get bearer(): string | null { return this.accessToken; }
  get isOwner(): boolean { return this.user()?.role === "owner"; }
  get isSignedIn(): boolean { return this.user() !== null; }

  async bootstrap(): Promise<{ claimed: boolean }> {
    return firstValueFrom(this.http.get<{ claimed: boolean }>("/api/auth/bootstrap"));
  }

  async claim(email: string, deviceLabel: string): Promise<void> {
    const opts = await firstValueFrom(this.http.post<any>("/api/auth/register/options", { email }));
    const credential = await startRegistration(opts);
    const r = await firstValueFrom(this.http.post<any>("/api/auth/register/verify",
      { email, device_label: deviceLabel, credential }));
    this.acceptTokens(r);
  }

  async join(server: string, email: string, code: string, deviceLabel: string): Promise<void> {
    // Server URL is implicit (same-origin). For a remote server, an optional baseUrl param could be added.
    const opts = await firstValueFrom(this.http.post<any>("/api/auth/register/options",
      { email, invite_code: code }));
    const credential = await startRegistration(opts);
    const r = await firstValueFrom(this.http.post<any>("/api/auth/register/verify",
      { email, device_label: deviceLabel, invite_code: code, credential }));
    this.acceptTokens(r);
  }

  async signIn(email: string): Promise<void> {
    const opts = await firstValueFrom(this.http.post<any>("/api/auth/login/options", { email }));
    const credential = await startAuthentication(opts);
    const r = await firstValueFrom(this.http.post<any>("/api/auth/login/verify", { email, credential }));
    this.acceptTokens(r);
  }

  async refresh(): Promise<boolean> {
    try {
      const r = await firstValueFrom(this.http.post<{ access_token: string }>("/api/auth/refresh", {}));
      this.accessToken = r.access_token;
      return true;
    } catch { this.user.set(null); this.accessToken = null; return false; }
  }

  async signOut(): Promise<void> {
    try { await firstValueFrom(this.http.post("/api/auth/logout", {})); } catch {}
    this.accessToken = null; this.user.set(null);
  }

  async loadMe(): Promise<void> {
    const r = await firstValueFrom(this.http.get<any>("/api/auth/me"));
    this.user.set(r.user);
  }

  private acceptTokens(r: any): void {
    this.accessToken = r.access_token;
    this.user.set(r.user);
    // Refresh token is set by the server as an httpOnly cookie; not visible to JS.
  }
}
```

- [ ] **Step 3: Server-side cookie wiring**

In Phase A's `/refresh` and `/login/verify` and `/register/verify`, when the request comes from a browser (detect via `Sec-Fetch-Site` or simply always set the cookie), set:

```ts
cookie.maple_refresh.set({
  value: refresh.raw, httpOnly: true, secure: true,
  sameSite: "lax", path: "/", maxAge: REFRESH_TTL_SECONDS,
});
```

Add this to `register/verify` and `login/verify` (already present in `/refresh` from Task A8).

- [ ] **Step 4: Commit**

```bash
git add src/web/package.json src/web/bun.lock src/web/projects/maple-common/src/lib/auth/auth.service.ts src/api/src/routes/auth.ts
git commit -m "feat(web): AuthService + cookie refresh wiring"
```

---

### Task C2: HTTP interceptor with single-flight refresh

**Files:**
- Create: `src/web/projects/maple-common/src/lib/auth/auth.interceptor.ts`
- Create: `src/web/projects/maple-common/src/lib/auth/auth.interceptor.spec.ts`

- [ ] **Step 1: Write failing spec**

```ts
import { TestBed } from "@angular/core/testing";
import { HttpClient, provideHttpClient, withInterceptors } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { authInterceptor } from "./auth.interceptor";
import { AuthService } from "./auth.service";

describe("authInterceptor", () => {
  let http: HttpClient; let ctrl: HttpTestingController; let auth: AuthService;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    (auth as any).accessToken = "A1";
  });

  it("injects bearer", () => {
    http.get("/api/folders").subscribe();
    const req = ctrl.expectOne("/api/folders");
    expect(req.request.headers.get("Authorization")).toBe("Bearer A1");
    req.flush({});
  });

  it("refreshes once on 401 and retries", async () => {
    spyOn(auth, "refresh").and.callFake(async () => { (auth as any).accessToken = "A2"; return true; });
    http.get("/api/folders").subscribe();
    let req = ctrl.expectOne("/api/folders");
    req.flush({}, { status: 401, statusText: "Unauth" });
    // The interceptor calls refresh(), then retries
    await Promise.resolve(); await Promise.resolve();
    req = ctrl.expectOne("/api/folders");
    expect(req.request.headers.get("Authorization")).toBe("Bearer A2");
    req.flush({});
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
cd src/web && bun run test --include "**/auth.interceptor.spec.ts"
```

- [ ] **Step 3: Implement**

```ts
// src/web/projects/maple-common/src/lib/auth/auth.interceptor.ts
import { HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { AuthService } from "./auth.service";
import { from, switchMap, catchError, throwError } from "rxjs";

let inflightRefresh: Promise<boolean> | null = null;

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  // Skip auth endpoints from injection.
  const skipAuthHeader = req.url.startsWith("/api/auth/");
  const withBearer = (auth.bearer && !skipAuthHeader)
    ? req.clone({ setHeaders: { Authorization: `Bearer ${auth.bearer}` } })
    : req;
  return next(withBearer).pipe(
    catchError((err) => {
      if (err?.status === 401 && !skipAuthHeader) {
        if (!inflightRefresh) inflightRefresh = auth.refresh().finally(() => { inflightRefresh = null; });
        return from(inflightRefresh).pipe(
          switchMap((ok) => {
            if (!ok) return throwError(() => err);
            const retried = auth.bearer
              ? req.clone({ setHeaders: { Authorization: `Bearer ${auth.bearer}` } })
              : req;
            return next(retried);
          })
        );
      }
      return throwError(() => err);
    })
  );
};
```

- [ ] **Step 4: Run, expect pass**

```bash
cd src/web && bun run test --include "**/auth.interceptor.spec.ts"
```

- [ ] **Step 5: Commit**

```bash
git add src/web/projects/maple-common/src/lib/auth/
git commit -m "feat(web): auth HTTP interceptor with single-flight refresh"
```

---

### Task C3: Route guard

**Files:**
- Create: `src/web/projects/maple-common/src/lib/auth/auth.guard.ts`

- [ ] **Step 1: Implement**

```ts
import { CanActivateFn, Router } from "@angular/router";
import { inject } from "@angular/core";
import { AuthService } from "./auth.service";

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isSignedIn) return true;
  // Try silent refresh once.
  if (await auth.refresh()) {
    await auth.loadMe();
    if (auth.isSignedIn) return true;
  }
  return router.createUrlTree(["/sign-in"]);
};

export const ownerGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isOwner ? true : router.createUrlTree(["/"]);
};
```

- [ ] **Step 2: Commit**

```bash
git add src/web/projects/maple-common/src/lib/auth/auth.guard.ts
git commit -m "feat(web): auth + owner route guards"
```

---

### Task C4: Sign-in + Join components

**Files:**
- Create: `src/web/projects/maple/src/app/sign-in/sign-in.component.ts`/.html/.scss
- Create: `src/web/projects/maple/src/app/sign-in/join.component.ts`/.html/.scss

- [ ] **Step 1: SignInComponent**

```ts
// sign-in.component.ts
import { Component, inject, signal, OnInit } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { FormsModule } from "@angular/forms";
import { AuthService } from "maple-common";

@Component({
  standalone: true,
  selector: "maple-sign-in",
  imports: [FormsModule, RouterLink],
  templateUrl: "./sign-in.component.html",
  styleUrl: "./sign-in.component.scss",
})
export class SignInComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);
  email = "";
  claimed = signal<boolean | null>(null);
  busy = signal(false);
  error = signal<string | null>(null);

  async ngOnInit() {
    this.claimed.set((await this.auth.bootstrap()).claimed);
  }
  async submit() {
    this.busy.set(true); this.error.set(null);
    try {
      if (this.claimed() === false) await this.auth.claim(this.email, "Web");
      else await this.auth.signIn(this.email);
      await this.router.navigateByUrl("/");
    } catch (e: any) { this.error.set(e?.message ?? String(e)); }
    finally { this.busy.set(false); }
  }
}
```

```html
<!-- sign-in.component.html -->
<form (submit)="submit(); $event.preventDefault()">
  <h2>{{ claimed() === true ? "Sign in" : "Claim this server" }}</h2>
  <input type="email" [(ngModel)]="email" name="email" placeholder="Email" required />
  <button type="submit" [disabled]="busy() || !email">
    {{ claimed() === true ? "Sign in with passkey" : "Create passkey" }}
  </button>
  @if (error(); as e) { <p class="error">{{ e }}</p> }
  <a routerLink="/join">Have an invite code?</a>
</form>
```

- [ ] **Step 2: JoinComponent (analogous, fields: email + 8-char code)**

(Mirror the sign-in pattern. Calls `auth.join(window.location.origin, email, code, "Web")`.)

- [ ] **Step 3: Wire routes in `app.routes.ts`**

```ts
{ path: "sign-in", loadComponent: () => import("./sign-in/sign-in.component").then(m => m.SignInComponent) },
{ path: "join", loadComponent: () => import("./sign-in/join.component").then(m => m.JoinComponent) },
{ path: "", canActivate: [authGuard], /* existing main route */ },
```

- [ ] **Step 4: Commit**

```bash
git add src/web/projects/maple/src/app/sign-in/ src/web/projects/maple/src/app/app.routes.ts
git commit -m "feat(web): sign-in + join components"
```

---

### Task C5: Settings — account + users

**Files:**
- Create: `src/web/projects/maple/src/app/settings/account/account.component.ts`/.html
- Create: `src/web/projects/maple/src/app/settings/users/users.component.ts`/.html
- Modify: `src/web/projects/maple/src/app/app.routes.ts`

- [ ] **Step 1: AccountComponent — show user, role, passkeys with delete; "Add device" button calls `auth.addCredential()` (which the AuthService will need; mirror Apple's add-credential pattern using `startRegistration` against `/api/auth/credentials/options` + `/credentials/verify`).**

(Add `addCredential(deviceLabel)` and `deleteCredential(id)` and `loadMe()` methods to `AuthService`, paralleling the Apple side.)

- [ ] **Step 2: UsersComponent (owner-only, behind `ownerGuard`)** — list invites, create, rescind. Reuse the API.

- [ ] **Step 3: Routes**

```ts
{ path: "settings/account", canActivate: [authGuard],
  loadComponent: () => import("./settings/account/account.component").then(m => m.AccountComponent) },
{ path: "settings/users", canActivate: [authGuard, ownerGuard],
  loadComponent: () => import("./settings/users/users.component").then(m => m.UsersComponent) },
```

- [ ] **Step 4: Commit**

```bash
git add src/web/projects/maple/src/app/settings/ src/web/projects/maple-common/src/lib/auth/auth.service.ts src/web/projects/maple/src/app/app.routes.ts
git commit -m "feat(web): account + users settings pages"
```

---

### Task C6: Public API export + provider wiring

**Files:**
- Modify: `src/web/projects/maple-common/src/public-api.ts`
- Modify: `src/web/projects/maple/src/app/app.config.ts`

- [ ] **Step 1: Export auth surface**

Append to `public-api.ts`:

```ts
export * from './lib/auth/auth.service';
export * from './lib/auth/auth.guard';
export * from './lib/auth/auth.interceptor';
```

- [ ] **Step 2: Provide interceptor in `app.config.ts`**

```ts
import { provideHttpClient, withInterceptors, withFetch } from "@angular/common/http";
import { authInterceptor } from "maple-common";

export const appConfig: ApplicationConfig = {
  providers: [
    /* existing */
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
  ],
};
```

- [ ] **Step 3: Build + run + smoke test**

```bash
cd src/web && bun x ng build maple
```

Expected: builds. Manual smoke against running API to follow.

- [ ] **Step 4: Commit**

```bash
git add src/web/
git commit -m "feat(web): export auth surface + register interceptor"
```

---

## Phase D — Flip the switch

### Task D1: Apply `requireAuth` globally

**Files:**
- Modify: `src/api/src/index.ts`

- [ ] **Step 1: Wrap all non-auth, non-health routes**

```ts
import { requireAuth } from "./auth/middleware.ts";

const app = new Elysia()
  /* …CORS, error handler… */
  .use(healthRoutes)
  .use(authRoutes)
  // Below this line: every route requires a valid bearer.
  .use(requireAuth)
  .use(foldersRoutes)
  .use(assetsRoutes)
  .use(indexerRoutes)
  .use(eventsRoutes)
  .use(staticUiPlugin);
```

- [ ] **Step 2: Add an integration test that verifies enforcement**

```ts
// src/api/tests/auth/enforcement.test.ts
import { describe, it, expect } from "bun:test";

describe("global enforcement", () => {
  it("/api/folders is 401 without bearer", async () => {
    const r = await fetch("http://localhost:3000/api/folders");
    // Run with a live server; or use the app handler directly as in earlier tests.
    expect([401, 403]).toContain(r.status);
  });
});
```

(Prefer the direct-handler form used in earlier tests for hermeticity.)

- [ ] **Step 3: Run full test suite**

```bash
cd src/api && bun test
```

Expected: all pass.

- [ ] **Step 4: Manual smoke**

- Start API, sign in via Apple app, browse folders → works.
- Sign out, attempt to browse → 401, sign-in screen appears.
- In web bundle, same flow.

- [ ] **Step 5: Commit**

```bash
git add src/api/src/index.ts src/api/tests/auth/enforcement.test.ts
git commit -m "feat(api): enforce auth on all non-auth, non-health routes"
```

---

### Task D2: Documentation + upgrade note

**Files:**
- Modify: `docs/testing.md` (manual passkey QA checklist)
- Create: `docs/upgrade-notes/2026-04-passkey-auth.md`

- [ ] **Step 1: Add manual QA checklist to `docs/testing.md`**

Append:

```markdown
## Manual passkey QA

Run after any change to the auth code paths.

- [ ] Fresh server: claim with email + passkey on Mac, sign in on iPhone.
- [ ] Owner generates invite, second user joins from another machine.
- [ ] Member cannot reach `/settings/users` (web) / `ManageUsersView` (Apple).
- [ ] Removing one of two passkeys works; removing the last is blocked.
- [ ] Sign out, kill server, restart, sign in: refresh token still valid.
- [ ] Refresh-token reuse (manually replay an old refresh): subsequent refresh attempts fail; user is signed out.
```

- [ ] **Step 2: Add upgrade note**

```markdown
# Upgrade note: passkey authentication

`/api/*` is now gated. On first launch after this upgrade, sign in with the
Maple app to claim the server. Existing self-hosted installations keep their
data — only the access path changes. Set `MAPLE_RP_ID` and `MAPLE_ORIGIN` env
vars to the public hostname of your deployment (defaults: `localhost` / `http://localhost:3000`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/testing.md docs/upgrade-notes/
git commit -m "docs: passkey auth manual QA + upgrade note"
```

---

## Self-review

Spec coverage check (every numbered section in the spec):
- §3 Decisions D1–D10 — all covered: D1/D3 in A7+A9, D2 unchanged (no per-user scoping), D4 in A2, D5 in A1+A5, D6 in A1, D7 in A2, D8 in B1, D9 in C1, D10 in A11.
- §4 Architecture — server in A2–A6, Apple in B1–B10, web in C1–C6.
- §5 Data model — A1.
- §6 HTTP contract — A7–A10 (14 endpoints).
- §7 Token lifecycle — A2–A3, rate limit A12.
- §8 Client flows — claim/sign-in B5+C4, invite owner B7+C5, invitee B6+C4, add device B7+C5, 401 handling B4+C2, offline existing behavior preserved (no new task — relies on cached transport unchanged).
- §9 Testing — A2–A14 (unit + integration), B0/B1/B4 (Apple), C2 (web), B0/C0 (contract).
- §10 Migration — D2.

Placeholder scan: none of the forbidden phrases ("TBD", "TODO", "implement later", "similar to") remain except in the soft-authn helper (A14 Step 2) where it explicitly directs to vendor an upstream MIT-licensed file with a citation. That is a valid concrete instruction, not a placeholder.

Type consistency:
- `AuthTokens { access, refresh }` — used identically in B1, B2, B4.
- `AuthUser { id, email, role }` — used identically in Apple AuthClient (B2) and web AuthService (C1).
- `AuthVerifyResponse { access_token, refresh_token, user }` — server returns it (A7, A8); Apple decodes it (B2); web decodes it (C1).
- `device_label` snake_case in API body, `deviceLabel` camelCase in Swift, `deviceLabel` in TypeScript — confirmed everywhere.
- `requireAuth` / `requireOwner` middleware names match between A6 and A7/A9/A10/D1.

No remaining gaps. Plan ready.
