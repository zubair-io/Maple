// src/api/src/auth/webauthn.ts
import { ObjectId } from "mongodb";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
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
