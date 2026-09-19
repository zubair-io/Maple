// src/api/src/auth/webauthn.ts
import type { ObjectId } from 'mongodb';
import { randomBytes } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import { consumeChallenge, storeChallenge } from '../db/sqlite/repos/auth.challenges.repo.ts';
import { listCredentialDescriptorsForUser } from '../db/sqlite/repos/auth.users.repo.ts';
import { allowedBrowserOrigins } from '../runtime/allowed-origins.ts';
import type { CredentialDoc } from '../db/schema.ts';

// The ceremony logic is `@simplewebauthn/server` and has no database in it.
// The two things here that did — recording a challenge and spending it — moved
// to `db/sqlite/repos/auth.challenges.repo.ts` at the cutover (#3787), along
// with the five-minute lifetime and both of the error messages the register
// and login routes surface. A challenge is still spendable exactly once: the
// `findOneAndDelete` became a read followed by a delete whose row count
// identifies the single winner.

const RP_NAME = 'Maple';
function rpID(): string {
  return process.env.MAPLE_RP_ID ?? 'localhost';
}

// Allowed WebAuthn origins come from `runtime/allowed-origins.ts`:
// MAPLE_ORIGIN (or the dev localhost ports) plus the managed LAN HTTPS
// hostname while that listener is serving. SimpleWebAuthn accepts the array.

/**
 * One WebAuthn registration ceremony: parse the clientDataJSON challenge,
 * consume the stored row, gate on the caller's expectation, then verify the
 * attestation. Shared by `register/verify` (auth.ts) and
 * `credentials/verify` (auth-account.ts) — the two flows differ only in
 * what the consumed challenge row must prove (`expect`).
 *
 * Throws (like `consumeChallenge`) on a missing/expired challenge; returns
 * `{ ok: false }` for the two 400-shaped failures the callers report.
 */
export async function consumeRegistrationCeremony(args: {
  credential: any;
  expect: (row: Awaited<ReturnType<typeof consumeChallenge>>) => boolean;
}): Promise<
  | {
      ok: true;
      challengeRow: Awaited<ReturnType<typeof consumeChallenge>>;
      registrationInfo: NonNullable<VerifiedRegistrationResponse['registrationInfo']>;
    }
  | { ok: false; error: string }
> {
  const clientChallenge = args.credential?.response?.clientDataJSON
    ? JSON.parse(Buffer.from(args.credential.response.clientDataJSON, 'base64url').toString())
        .challenge
    : '';
  const challengeRow = await consumeChallenge(clientChallenge);
  if (!args.expect(challengeRow)) return { ok: false, error: 'challenge mismatch' };
  const verification = await verifyRegistration({
    response: args.credential,
    expectedChallenge: challengeRow.challenge,
  });
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'verification failed' };
  }
  return { ok: true, challengeRow, registrationInfo: verification.registrationInfo };
}

/**
 * The passkey row a verified registration becomes.
 *
 * Both registration flows — a new account in `auth.ts`, an extra device in
 * `auth-account.ts` — reach this point with the same verified ceremony and
 * wrote the same eight fields out of it. The public key is the one field that
 * needs converting rather than copying: SimpleWebAuthn hands back a
 * `Uint8Array` and the column holds a `Buffer`.
 */
export function credentialFromRegistration(args: {
  userId: ObjectId;
  registrationInfo: NonNullable<VerifiedRegistrationResponse['registrationInfo']>;
  transports: string[] | undefined;
  deviceLabel: string;
  now: string;
}): CredentialDoc {
  const { credential } = args.registrationInfo;
  return {
    user_id: args.userId,
    credential_id: credential.id,
    public_key: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: args.transports ?? [],
    device_label: args.deviceLabel,
    created_at: args.now,
    last_used_at: args.now,
  };
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
    // WebAuthn user handle (#864): never the email — that put PII in the
    // credential, against library guidance. For an additional credential on an
    // existing user, reuse the stable account id (`_id`) so the authenticator
    // groups the user's passkeys together. For a brand-new account (no `_id`
    // yet), mint a random 32-byte handle; we never look users up by handle
    // (credentials are keyed by `credential_id`), so an opaque value is fine.
    userID: args.existingUserId
      ? new TextEncoder().encode(args.existingUserId.toHexString())
      : new Uint8Array(randomBytes(32)),
    userName: args.email,
    attestationType: 'none',
    // residentKey 'required' (#1304): store a DISCOVERABLE credential so the user
    // can sign in without first typing an email — the authenticator offers the
    // passkey and the server identifies the account from the credential id.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: args.excludeCredentialIds.map((id) => ({ id })),
  });
  await storeChallenge({
    challenge: opts.challenge,
    purpose: args.existingUserId ? 'add_credential' : 'register',
    user_id: args.existingUserId,
    email: args.email.toLowerCase(),
    invite_code: args.inviteCode,
  });
  return opts;
}

async function verifyRegistration(args: {
  response: any;
  expectedChallenge: string;
}): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: allowedBrowserOrigins(),
    expectedRPID: rpID(),
    requireUserVerification: false,
  });
}

export async function buildAuthenticationOptions(userId: ObjectId, email: string) {
  // Ids and transports only — a passkey's COSE public key has no place in a
  // ceremony's options, and the repository's projection keeps it out.
  const allowed = await listCredentialDescriptorsForUser(userId);
  const opts = await generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials: allowed.map((c) => ({
      id: c.credential_id,
      transports: c.transports as any,
    })),
    userVerification: 'preferred',
  });
  await storeChallenge({
    challenge: opts.challenge,
    purpose: 'authenticate',
    user_id: userId,
    email: email.toLowerCase(),
    invite_code: null,
  });
  return opts;
}

/**
 * Usernameless / discoverable-credential authentication options (#1304). No
 * email is known yet, so `allowCredentials` is empty — the authenticator offers
 * whichever resident passkey the user picks for this RP, and `login/verify`
 * identifies the account from the asserted credential id. The challenge is
 * stored unbound to any user (`user_id`/`email` null); it's single-use and the
 * assertion's signature is what authenticates.
 */
export async function buildDiscoverableAuthenticationOptions() {
  const opts = await generateAuthenticationOptions({
    rpID: rpID(),
    allowCredentials: [],
    userVerification: 'preferred',
  });
  await storeChallenge({
    challenge: opts.challenge,
    purpose: 'authenticate',
    user_id: null,
    email: null,
    invite_code: null,
  });
  return opts;
}

/**
 * Read a stored credential public key as a tight `Uint8Array<ArrayBuffer>`.
 *
 * A stored key comes back as a Node `Buffer`, which is a view into a shared
 * pool: its `.buffer` is the WHOLE pool (extra bytes + wrong length), so we copy
 * the Buffer itself — which respects byteOffset/length — and never its
 * underlying ArrayBuffer. The `.buffer`-unwrapping branch below also accepts the
 * wrapper shape the MongoDB driver used to hand back (a BSON `Binary`), so a
 * change in what the store returns can't silently corrupt the key and break
 * every login.
 */
function credentialPublicKeyBytes(pk: unknown): Uint8Array<ArrayBuffer> {
  if (pk instanceof Uint8Array) return Uint8Array.from(pk); // Node Buffer / Uint8Array
  const buf = (pk as { buffer?: unknown } | null)?.buffer; // wrapper shape
  if (buf instanceof Uint8Array) return Uint8Array.from(buf);
  if (buf) return Uint8Array.from(new Uint8Array(buf as ArrayBufferLike));
  return new Uint8Array(0);
}

export async function verifyAuthentication(args: {
  response: any;
  expectedChallenge: string;
  credential: CredentialDoc;
}): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: args.expectedChallenge,
    expectedOrigin: allowedBrowserOrigins(),
    expectedRPID: rpID(),
    // Match the "preferred" client-side policy in `buildAuthenticationOptions`
    // — accept assertions whether UV happened or not. SimpleWebAuthn defaults
    // this to `true`, which over-restricts and rejects passkeys created on
    // platforms that don't gate the signature with UV (USB security keys
    // without PIN, synced passkeys on devices without biometric/PIN setup).
    // The hardened policy is "required" on both sides; we choose "preferred".
    requireUserVerification: false,
    credential: {
      id: args.credential.credential_id,
      publicKey: credentialPublicKeyBytes(args.credential.public_key),
      counter: args.credential.counter,
      transports: args.credential.transports as any,
    },
  });
}

export { consumeChallenge };
