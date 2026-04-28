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
