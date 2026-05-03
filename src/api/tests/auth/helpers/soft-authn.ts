/**
 * Minimal WebAuthn soft authenticator for end-to-end tests.
 *
 * Why hand-rolled (Path B): @simplewebauthn/server (v11) does not publish a
 * reusable test authenticator helper. The library's own test suite uses static
 * fixtures, not a programmable authenticator. So we implement the smallest
 * possible compliant authenticator here: ES256 (P-256 / SHA-256), "none"
 * attestation, single resident credential.
 *
 * Spec references:
 *  - WebAuthn Level 3, § 6.5.4 "Authenticator data"
 *  - WebAuthn Level 3, § 8.7  "None attestation statement format"
 *  - RFC 8152 (COSE) for the public-key encoding
 *
 * We reuse @simplewebauthn/server's own CBOR encoder so that the COSE key
 * round-trips through the verifier byte-for-byte (the verifier is picky about
 * map key ordering / typed-array tags — see the comment in `isoCBOR.ts`).
 */

import { isoCBOR, cose } from "@simplewebauthn/server/helpers";
import { createHash, webcrypto } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u16be(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = (n >>> 8) & 0xff;
  b[1] = n & 0xff;
  return b;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

// Convert raw P-256 public-key coordinates exported by Web Crypto's "raw" SPKI
// format (uncompressed: 0x04 || X(32) || Y(32)) into x and y byte arrays.
function splitP256Raw(raw: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error(`unexpected P-256 raw key length=${raw.length} first=${raw[0]}`);
  }
  return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

// Convert WebCrypto's IEEE-P1363 fixed 64-byte ECDSA signature (r||s) into
// the DER-encoded ASN.1 form that WebAuthn (and @simplewebauthn) expects.
function p1363ToDer(sig: Uint8Array): Uint8Array {
  if (sig.length !== 64) throw new Error(`bad p1363 length=${sig.length}`);
  const r = trimLeadingZeros(sig.slice(0, 32));
  const s = trimLeadingZeros(sig.slice(32, 64));
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const seqLen = rEnc.length + sEnc.length;
  return concat(new Uint8Array([0x30, seqLen]), rEnc, sEnc);
}

function trimLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.slice(i);
}

function encodeInt(b: Uint8Array): Uint8Array {
  // High bit set → prefix 0x00 to keep INTEGER positive.
  const needsPad = (b[0] & 0x80) !== 0;
  const body = needsPad ? concat(new Uint8Array([0x00]), b) : b;
  return concat(new Uint8Array([0x02, body.length]), body);
}

// ---------------------------------------------------------------------------
// Authenticator
// ---------------------------------------------------------------------------

const AAGUID = new Uint8Array(16); // all zeros — fine for "none" attestation.

export interface SoftAuthenticator {
  /** base64url credential id (random 32 bytes) */
  credentialId: string;
  /** signs an authenticator-data + clientData hash for assertion */
  buildAssertion(args: {
    challenge: string; // base64url
    rpId: string;
    origin: string;
  }): Promise<{
    id: string;
    rawId: string;
    type: "public-key";
    clientExtensionResults: Record<string, never>;
    response: {
      clientDataJSON: string; // base64url
      authenticatorData: string; // base64url
      signature: string; // base64url
      userHandle: string | null;
    };
  }>;
}

/**
 * Run a registration ceremony and return both the JSON response (to POST
 * to `/register/verify`) and a `SoftAuthenticator` handle that can later
 * mint assertion responses for sign-in.
 */
export async function buildRegistrationResponse(args: {
  challenge: string; // base64url challenge from /register/options
  rpId: string;
  origin: string;
}): Promise<{
  authenticator: SoftAuthenticator;
  response: {
    id: string;
    rawId: string;
    type: "public-key";
    clientExtensionResults: Record<string, never>;
    response: {
      clientDataJSON: string;
      attestationObject: string;
      transports: string[];
    };
  };
}> {
  // 1. Generate an ES256 (P-256) keypair via Web Crypto.
  const keyPair = (await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const rawPub = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  const { x, y } = splitP256Raw(rawPub);

  // 2. Random credential id.
  const credIdBytes = new Uint8Array(32);
  webcrypto.getRandomValues(credIdBytes);

  // 3. COSE public key for ES256 (kty=2 EC2, alg=-7 ES256, crv=1 P-256).
  // Use a Map per @simplewebauthn's CBOR contract (see isoCBOR comment).
  const coseKey = new Map<number, number | Uint8Array>();
  coseKey.set(cose.COSEKEYS.kty, cose.COSEKTY.EC2);
  coseKey.set(cose.COSEKEYS.alg, cose.COSEALG.ES256);
  coseKey.set(cose.COSEKEYS.crv, cose.COSECRV.P256);
  coseKey.set(cose.COSEKEYS.x, x);
  coseKey.set(cose.COSEKEYS.y, y);
  const coseKeyBytes = isoCBOR.encode(coseKey as Parameters<typeof isoCBOR.encode>[0]);

  // 4. authData layout (registration includes attested credential data).
  // flags: bit0 UP=1, bit2 UV=1, bit6 AT=1 → 0b01000101 = 0x45
  const rpIdHash = sha256(new TextEncoder().encode(args.rpId));
  const flags = new Uint8Array([0x45]);
  const signCount = u32be(0);
  const credIdLen = u16be(credIdBytes.length);
  const authData = concat(rpIdHash, flags, signCount, AAGUID, credIdLen, credIdBytes, coseKeyBytes);

  // 5. attestationObject: { fmt: "none", attStmt: {}, authData }
  const attMap = new Map<string, unknown>();
  attMap.set("fmt", "none");
  attMap.set("attStmt", new Map());
  attMap.set("authData", authData);
  const attestationObject = isoCBOR.encode(
    attMap as Parameters<typeof isoCBOR.encode>[0]
  );

  // 6. clientDataJSON.
  const clientData = JSON.stringify({
    type: "webauthn.create",
    challenge: args.challenge,
    origin: args.origin,
    crossOrigin: false,
  });
  const clientDataJSON = new TextEncoder().encode(clientData);

  const credentialId = b64url(credIdBytes);

  // Closure for assertions.
  const buildAssertion: SoftAuthenticator["buildAssertion"] = async (a) => {
    const aRpIdHash = sha256(new TextEncoder().encode(a.rpId));
    const aFlags = new Uint8Array([0x05]); // UP=1, UV=1, AT=0
    // Increment sign count for replay protection — start at 1.
    const aSignCount = u32be(1);
    const aAuthData = concat(aRpIdHash, aFlags, aSignCount);
    const aClientData = JSON.stringify({
      type: "webauthn.get",
      challenge: a.challenge,
      origin: a.origin,
      crossOrigin: false,
    });
    const aClientDataBytes = new TextEncoder().encode(aClientData);
    const aClientDataHash = sha256(aClientDataBytes);
    const signedBytes = concat(aAuthData, aClientDataHash);
    // Copy into a fresh ArrayBuffer-backed view so the lib.dom.d.ts
    // BufferSource constraint (ArrayBuffer, not ArrayBufferLike) is satisfied.
    const signedBuf = new Uint8Array(new ArrayBuffer(signedBytes.length));
    signedBuf.set(signedBytes);
    const sigP1363 = new Uint8Array(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        signedBuf
      )
    );
    const sigDer = p1363ToDer(sigP1363);
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(aClientDataBytes),
        authenticatorData: b64url(aAuthData),
        signature: b64url(sigDer),
        userHandle: null,
      },
    };
  };

  return {
    authenticator: { credentialId, buildAssertion },
    response: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    },
  };
}
