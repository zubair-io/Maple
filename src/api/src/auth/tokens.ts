import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "node:crypto";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

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
  const sig = b64urlEncode(hmac(sha256, utf8(secret), utf8(data)));
  return `${data}.${sig}`;
}

export function verifyAccessToken(jwt: string, secret: string): AccessClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;
  const expected = b64urlEncode(hmac(sha256, utf8(secret), utf8(`${h}.${p}`)));
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
  return Buffer.from(sha256(utf8(raw))).toString("hex");
}

export function refreshExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
}
