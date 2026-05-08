import { describe, it, expect, beforeEach } from "bun:test";
import { ObjectId } from "mongodb";
import { createInvite, redeemInvite, listInvites, rescindInvite } from "../../src/auth/invites.ts";
import { invitesCollection } from "../../src/db/client.ts";

const owner = new ObjectId();

beforeEach(async () => { await (await invitesCollection()).deleteMany({}); });

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
