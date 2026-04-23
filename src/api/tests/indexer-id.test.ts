/**
 * BLAKE3 maple:id parity — matches raw-core's MapleId::{primary,fallback}
 * byte-for-byte, per spec §04.
 *
 * Rather than depend on a cross-language fixture file, the expected values
 * are computed here via the exact spec formula (BLAKE3 over the
 * concatenation of SHA-1(head) + timestamp + serial + le_u64(shutter)).
 * We then assert our `./id.ts` wrapper produces the same 16-byte output.
 */

import { describe, it, expect } from "bun:test";
import { blake3 } from "@noble/hashes/blake3.js";
import { sha1 } from "@noble/hashes/legacy.js";

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

function leU64(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, typeof n === "bigint" ? n : BigInt(n), true);
  return out;
}

describe("maple:id primary", () => {
  it("matches the spec formula exactly", async () => {
    const { primary } = await import("../src/indexer/id.ts");

    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const ts = "2024:06:01 12:34:56";
    const serial = "SN-1234";
    const shutter = 4242n;

    // Expected: 0x01 || BLAKE3(SHA1(head) || ts || serial || le_u64(shutter))[..15]
    const headHash = sha1(bytes);
    const toHash = new Uint8Array(
      headHash.length + ts.length + serial.length + 8
    );
    toHash.set(headHash, 0);
    toHash.set(new TextEncoder().encode(ts), headHash.length);
    toHash.set(new TextEncoder().encode(serial), headHash.length + ts.length);
    toHash.set(leU64(shutter), headHash.length + ts.length + serial.length);
    const digest = blake3(toHash);
    const expected = new Uint8Array(16);
    expected[0] = 0x01;
    expected.set(digest.subarray(0, 15), 1);

    const id = primary(bytes, ts, serial, shutter);
    expect(id.hex).toBe(toHex(expected));
    expect(id.kind).toBe("primary");
    expect(id.bytes.length).toBe(16);
    expect(id.bytes[0]).toBe(0x01);
  });

  it("uses empty bytes for missing serial + 0 shutter", async () => {
    const { primary } = await import("../src/indexer/id.ts");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const ts = "2024:06:01 12:34:56";

    const headHash = sha1(bytes);
    const toHash = new Uint8Array(headHash.length + ts.length + 0 + 8);
    toHash.set(headHash, 0);
    toHash.set(new TextEncoder().encode(ts), headHash.length);
    toHash.set(leU64(0), headHash.length + ts.length);
    const digest = blake3(toHash);
    const expected = new Uint8Array(16);
    expected[0] = 0x01;
    expected.set(digest.subarray(0, 15), 1);

    const id = primary(bytes, ts, null, null);
    expect(id.hex).toBe(toHex(expected));
  });
});

describe("maple:id fallback", () => {
  it("matches the spec formula exactly", async () => {
    const { fallback } = await import("../src/indexer/id.ts");

    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;

    const sha1Full = sha1(bytes);
    const size = leU64(bytes.length);
    const toHash = new Uint8Array(sha1Full.length + 8);
    toHash.set(sha1Full, 0);
    toHash.set(size, sha1Full.length);
    const digest = blake3(toHash);
    const expected = new Uint8Array(16);
    expected[0] = 0x02;
    expected.set(digest.subarray(0, 15), 1);

    const id = fallback(bytes, bytes.length);
    expect(id.hex).toBe(toHex(expected));
    expect(id.kind).toBe("fallback");
    expect(id.bytes[0]).toBe(0x02);
  });
});

describe("maple:id fromHex", () => {
  it("round-trips", async () => {
    const { fromHex } = await import("../src/indexer/id.ts");
    const hex = "01abcdef123456789abcdef011223344";
    const id = fromHex(hex);
    expect(id.hex).toBe(hex);
    expect(id.kind).toBe("primary");
  });

  it("rejects wrong length", async () => {
    const { fromHex } = await import("../src/indexer/id.ts");
    expect(() => fromHex("abcd")).toThrow();
  });
});
