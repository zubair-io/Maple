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
import { challengesCollection, credentialsCollection } from '../db/client.ts';
import type { ChallengePurpose, CredentialDoc } from '../db/schema.ts';

const RP_NAME = 'Maple';
function rpID(): string {
  return process.env.MAPLE_RP_ID ?? 'localhost';
}

// Allowed WebAuthn origins. SimpleWebAuthn accepts an array — useful in dev,
// where the bun API runs on :3000 and the Angular dev server runs on :4201
// (or :4200 for hosted). MAPLE_ORIGIN can be a single origin or a
// comma-separated list. The default covers both common dev ports so the
// passkey ceremony works whether the user hits the bun-served bundle or
// ng-serve directly.
function origin(): string[] {
  const raw = process.env.MAPLE_ORIGIN;
  if (raw)
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return ['http://localhost:3000', 'http://localhost:4200', 'http://localhost:4201'];
}

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
  if (!row) throw new Error('challenge not found / already consumed');
  if (row.expires_at.getTime() < Date.now()) throw new Error('challenge expired');
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
 * MongoDB hands binary fields back as a BSON `Binary` (with a `.buffer` Node
 * Buffer) by default, or — under `promoteBuffers` — as a raw Node `Buffer`. A
 * Node Buffer is a view into a shared pool, so its `.buffer` is the WHOLE pool
 * (extra bytes + wrong length); we must copy the Buffer itself (which respects
 * byteOffset/length), not its underlying ArrayBuffer. Handles both shapes so a
 * driver/config change can't silently corrupt the key and break every login.
 */
function credentialPublicKeyBytes(pk: unknown): Uint8Array {
  if (pk instanceof Uint8Array) return Uint8Array.from(pk); // Node Buffer / Uint8Array
  const buf = (pk as { buffer?: unknown } | null)?.buffer; // BSON Binary
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
    expectedOrigin: origin(),
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
