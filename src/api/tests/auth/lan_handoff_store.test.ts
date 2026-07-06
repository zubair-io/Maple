import { describe, it, expect, beforeEach } from 'bun:test';
import { ObjectId } from 'mongodb';
import { issueLanHandoffCode, redeemLanHandoffCode } from '../../src/auth/lan_handoff_store.ts';
import { lanHandoffCodesCollection } from '../../src/db/client.ts';

const userId = new ObjectId();

beforeEach(async () => {
  const c = await lanHandoffCodesCollection();
  await c.deleteMany({});
});

describe('LAN handoff code store', () => {
  it('issues a code and redeems it', async () => {
    const { code } = await issueLanHandoffCode({ userId, deviceLabel: 'Local network session' });
    const r = await redeemLanHandoffCode(code);
    expect(r).not.toBeNull();
    expect(r!.userId.toHexString()).toBe(userId.toHexString());
    expect(r!.deviceLabel).toBe('Local network session');
  });

  it('is single-use: a second redeem returns null', async () => {
    const { code } = await issueLanHandoffCode({ userId, deviceLabel: 'Local network session' });
    expect(await redeemLanHandoffCode(code)).not.toBeNull();
    expect(await redeemLanHandoffCode(code)).toBeNull();
  });

  it('rejects an expired code', async () => {
    const { code } = await issueLanHandoffCode({ userId, deviceLabel: 'Local network session' });
    const c = await lanHandoffCodesCollection();
    await c.updateMany({}, { $set: { expires_at: new Date(Date.now() - 1000) } });
    expect(await redeemLanHandoffCode(code)).toBeNull();
  });

  it('rejects an unknown code', async () => {
    expect(await redeemLanHandoffCode('no-such-code')).toBeNull();
  });
});
