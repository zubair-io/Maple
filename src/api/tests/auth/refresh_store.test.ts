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
