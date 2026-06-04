import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { issueNativeCode, redeemNativeCode, pkceS256 } from '../../src/auth/native_code_store.ts';
import { nativeAuthCodesCollection } from '../../src/db/client.ts';

const userId = new ObjectId();

beforeEach(async () => {
  const c = await nativeAuthCodesCollection();
  await c.deleteMany({});
});

describe('native auth code store (#856)', () => {
  it('issues a code and redeems it with the matching verifier', async () => {
    const verifier = 'verifier-abc123';
    const { code } = await issueNativeCode({
      userId,
      codeChallenge: pkceS256(verifier),
      state: 'st1',
      deviceLabel: 'iPhone',
    });
    const r = await redeemNativeCode(code, verifier);
    expect(r).not.toBeNull();
    expect(r!.userId.toHexString()).toBe(userId.toHexString());
    expect(r!.deviceLabel).toBe('iPhone');
    expect(r!.state).toBe('st1');
  });

  it('rejects a wrong verifier WITHOUT burning the code (PKCE in the atomic match)', async () => {
    const verifier = 'right-verifier';
    const { code } = await issueNativeCode({
      userId,
      codeChallenge: pkceS256(verifier),
      state: 'st',
      deviceLabel: 'iPhone',
    });
    expect(await redeemNativeCode(code, 'wrong-verifier')).toBeNull();
    // The code survives a wrong verifier — the legit verifier still redeems.
    expect(await redeemNativeCode(code, verifier)).not.toBeNull();
  });

  it('is single-use: a second redeem returns null', async () => {
    const verifier = 'v';
    const { code } = await issueNativeCode({
      userId,
      codeChallenge: pkceS256(verifier),
      state: 'st',
      deviceLabel: 'iPhone',
    });
    expect(await redeemNativeCode(code, verifier)).not.toBeNull();
    expect(await redeemNativeCode(code, verifier)).toBeNull();
  });

  it('rejects an expired code', async () => {
    const verifier = 'v';
    const { code } = await issueNativeCode({
      userId,
      codeChallenge: pkceS256(verifier),
      state: 'st',
      deviceLabel: 'iPhone',
    });
    const c = await nativeAuthCodesCollection();
    await c.updateMany({}, { $set: { expires_at: new Date(Date.now() - 1000) } });
    expect(await redeemNativeCode(code, verifier)).toBeNull();
  });

  it('rejects an unknown code', async () => {
    expect(await redeemNativeCode('no-such-code', 'v')).toBeNull();
  });
});
