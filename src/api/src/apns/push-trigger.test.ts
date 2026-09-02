/**
 * ApnsPushTrigger tests. Uses a real (short-window) coalescing timer and a
 * fake sender injected via `senderFactory` — no real network or JWT signing
 * involved, since `apns-sender.test.ts` already covers the sender itself.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ObjectId, type Db } from 'mongodb';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';
import { getChangeBus, __resetChangeBusForTests } from '../runtime/change-bus.ts';
import type { AssetChangeWithId } from '../db/schema.ts';
import { registerDeviceToken, listAllDeviceTokens } from './apns-devices.repo.ts';
import { saveApnsSettingsConfig } from './apns-config.repo.ts';
import { ApnsPushTrigger } from './push-trigger.ts';
import type { ApnsSendResult } from './apns-sender.ts';

withTestDb(`maple_test_apns_push_trigger_${process.pid}`);

let db: Db | null = null;
let mongoReachable = false;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['MAPLE_APNS_KEY_ID', 'MAPLE_APNS_TEAM_ID', 'MAPLE_APNS_PRIVATE_KEY'] as const;

beforeAll(async () => {
  await closeDb();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  await db.collection('apns_device_tokens').deleteMany({});
  await db.collection('app_settings').deleteMany({ _id: 'apns' });
  __resetChangeBusForTests();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  __resetChangeBusForTests();
});

function fakeChange(folderId: ObjectId | null, cursor: number): AssetChangeWithId {
  return {
    _id: new ObjectId(),
    cursor,
    asset_id: new ObjectId(),
    folder_id: folderId,
    kind: 'update',
    abs_path: folderId ? '/lib/a.dng' : null,
    relative_path: folderId ? 'a.dng' : null,
    at: new Date(),
  };
}

function setEnvCreds(): void {
  process.env.MAPLE_APNS_KEY_ID = 'K';
  process.env.MAPLE_APNS_TEAM_ID = 'T';
  process.env.MAPLE_APNS_PRIVATE_KEY = 'P';
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ApnsPushTrigger', () => {
  it('does nothing when the DB setting is disabled', async () => {
    if (!mongoReachable || !db) return;
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok',
      platform: 'ios',
      environment: 'sandbox',
    });
    let calls = 0;
    const trigger = new ApnsPushTrigger({
      coalesceMs: 10,
      senderFactory: () => ({
        sendFileProviderWake: async (): Promise<ApnsSendResult> => {
          calls++;
          return { ok: true };
        },
      }),
    });
    trigger.start();
    getChangeBus().publish(fakeChange(new ObjectId(), 1));
    await wait(50);
    trigger.stop();
    expect(calls).toBe(0);
  });

  it('does nothing when enabled but credentials are unset', async () => {
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok',
      platform: 'ios',
      environment: 'sandbox',
    });
    let calls = 0;
    const trigger = new ApnsPushTrigger({
      coalesceMs: 10,
      senderFactory: () => ({
        sendFileProviderWake: async (): Promise<ApnsSendResult> => {
          calls++;
          return { ok: true };
        },
      }),
    });
    trigger.start();
    getChangeBus().publish(fakeChange(new ObjectId(), 1));
    await wait(50);
    trigger.stop();
    expect(calls).toBe(0);
  });

  it('coalesces a burst of changes — even across different libraries — into a single wake per device', async () => {
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-1',
      platform: 'ios',
      environment: 'sandbox',
    });
    const sent: string[] = [];
    const trigger = new ApnsPushTrigger({
      coalesceMs: 20,
      senderFactory: () => ({
        sendFileProviderWake: async (deviceToken: string): Promise<ApnsSendResult> => {
          sent.push(deviceToken);
          return { ok: true };
        },
      }),
    });
    trigger.start();
    // One push registration covers the whole server (a File Provider
    // domain is per-server, not per-library — see the module doc
    // comment), so changes to two different libraries in the same burst
    // must still coalesce into ONE wake.
    getChangeBus().publish(fakeChange(new ObjectId(), 1));
    getChangeBus().publish(fakeChange(new ObjectId(), 2));
    getChangeBus().publish(fakeChange(new ObjectId(), 3));
    await wait(80);
    trigger.stop();
    expect(sent).toEqual(['tok-1']);
  });

  it('is a true debounce — a burst whose TOTAL duration exceeds the window (but whose per-change gaps stay under it) still fires exactly once, after the burst quiets', async () => {
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-1',
      platform: 'ios',
      environment: 'sandbox',
    });
    let calls = 0;
    const trigger = new ApnsPushTrigger({
      coalesceMs: 30,
      senderFactory: () => ({
        sendFileProviderWake: async (): Promise<ApnsSendResult> => {
          calls++;
          return { ok: true };
        },
      }),
    });
    trigger.start();
    // 5 changes 20ms apart — each gap is under the 30ms window (so every
    // change resets the timer), but the burst spans 80ms total, well past
    // the window. A leading-edge throttle would have fired mid-burst; a
    // true debounce fires exactly once, after the last change settles.
    let cursor = 1;
    for (let i = 0; i < 5; i++) {
      getChangeBus().publish(fakeChange(new ObjectId(), cursor++));
      await wait(20);
    }
    expect(calls).toBe(0); // not yet — still inside the post-last-change window
    await wait(50); // past the 30ms window since the last change
    trigger.stop();
    expect(calls).toBe(1);
  });

  it('wakes every registered device, across every user', async () => {
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-a',
      platform: 'ios',
      environment: 'sandbox',
    });
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-b',
      platform: 'macos',
      environment: 'production',
    });
    const sent: string[] = [];
    const trigger = new ApnsPushTrigger({
      coalesceMs: 20,
      senderFactory: () => ({
        sendFileProviderWake: async (deviceToken: string): Promise<ApnsSendResult> => {
          sent.push(deviceToken);
          return { ok: true };
        },
      }),
    });
    trigger.start();
    getChangeBus().publish(fakeChange(new ObjectId(), 1));
    await wait(60);
    trigger.stop();
    expect(sent.sort()).toEqual(['tok-a', 'tok-b']);
  });

  it('reuses one sender across two separate bursts (regression, Jules review #3214)', async () => {
    // A fresh `ApnsSender` per burst throws away its own ~50-minute
    // provider-JWT cache every coalesce window — exactly the
    // TooManyProviderTokenUpdates footgun the cache exists to avoid.
    // `senderFactory` must therefore be invoked once total here, not once
    // per burst.
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-1',
      platform: 'ios',
      environment: 'sandbox',
    });
    let factoryCalls = 0;
    const trigger = new ApnsPushTrigger({
      coalesceMs: 15,
      senderFactory: () => {
        factoryCalls++;
        return {
          sendFileProviderWake: async (): Promise<ApnsSendResult> => ({ ok: true }),
        };
      },
    });
    trigger.start();
    getChangeBus().publish(fakeChange(new ObjectId(), 1));
    await wait(40); // let the first burst fire and fully settle
    getChangeBus().publish(fakeChange(new ObjectId(), 2));
    await wait(40); // second, separate burst
    trigger.stop();
    expect(factoryCalls).toBe(1);
  });

  it('one device rejecting the send does not block others in the same burst, and only prunes the rejected one', async () => {
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-throws',
      platform: 'ios',
      environment: 'sandbox',
    });
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-fine',
      platform: 'ios',
      environment: 'sandbox',
    });
    const sent: string[] = [];
    const trigger = new ApnsPushTrigger({
      coalesceMs: 10,
      senderFactory: () => ({
        sendFileProviderWake: async (deviceToken: string): Promise<ApnsSendResult> => {
          if (deviceToken === 'tok-throws') throw new Error('transport error');
          sent.push(deviceToken);
          return { ok: true };
        },
      }),
    });
    trigger.start();
    getChangeBus().publish(fakeChange(new ObjectId(), 1));
    await wait(50);
    trigger.stop();
    expect(sent).toEqual(['tok-fine']);
    // The thrown device is neither pruned (a transport failure says
    // nothing about whether the token itself is valid) nor removed by
    // any side effect of the other device's success.
    const remaining = await listAllDeviceTokens();
    expect(remaining.map((d) => d.device_token).sort()).toEqual(['tok-fine', 'tok-throws']);
  });

  it('prunes a device token APNs reports as permanently invalid', async () => {
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'dead-tok',
      platform: 'ios',
      environment: 'sandbox',
    });
    const trigger = new ApnsPushTrigger({
      coalesceMs: 10,
      senderFactory: () => ({
        sendFileProviderWake: async (): Promise<ApnsSendResult> => ({
          ok: false,
          status: 410,
          reason: 'Unregistered',
          shouldPrune: true,
        }),
      }),
    });
    trigger.start();
    getChangeBus().publish(fakeChange(new ObjectId(), 1));
    await wait(50);
    trigger.stop();
    expect(await listAllDeviceTokens()).toHaveLength(0);
  });

  it('still wakes for a change with no folder_id (e.g. a folder rescan)', async () => {
    if (!mongoReachable || !db) return;
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDeviceToken({
      userId: new ObjectId(),
      deviceToken: 'tok-1',
      platform: 'ios',
      environment: 'sandbox',
    });
    let calls = 0;
    const trigger = new ApnsPushTrigger({
      coalesceMs: 10,
      senderFactory: () => ({
        sendFileProviderWake: async (): Promise<ApnsSendResult> => {
          calls++;
          return { ok: true };
        },
      }),
    });
    trigger.start();
    getChangeBus().publish(fakeChange(null, 1));
    await wait(40);
    trigger.stop();
    expect(calls).toBe(1);
  });
});
