/**
 * ApnsPushTrigger tests. Uses a real (short-window) coalescing timer and a
 * fake sender injected via `senderFactory` — no real network or JWT signing
 * involved, since `apns-sender.test.ts` already covers the sender itself.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from 'bun:test';
import { ObjectId } from '../db/object-id.ts';
import {
  createLiveTestDatabase,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { newObjectIdHex } from '../db/object-id.ts';
import { getChangeBus, __resetChangeBusForTests } from '../runtime/change-bus.ts';
import type { AssetChangeWithId } from '../db/schema.ts';
import { registerDeviceToken, listAllDeviceTokens } from './apns-devices.repo.ts';
import * as apnsConfig from './apns-config.repo.ts';
import { saveApnsSettingsConfig } from './apns-config.repo.ts';
import { ApnsPushTrigger } from './push-trigger.ts';
import type { ApnsSendResult } from './apns-sender.ts';

let live: LiveTestDatabase;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['MAPLE_APNS_KEY_ID', 'MAPLE_APNS_TEAM_ID', 'MAPLE_APNS_PRIVATE_KEY'] as const;

beforeAll(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  // The trigger reads its settings row and its device list through the
  // process-wide handle, so the database has to be installed as that handle
  // rather than handed in.
  live = await createLiveTestDatabase();
  __resetChangeBusForTests();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  jest.useRealTimers();
  __resetChangeBusForTests();
  live.close();
});

/**
 * A registered device, and the user row its foreign key needs. Every case here
 * registers at least one; none of them cares which user owns it, because a wake
 * fans out to every device on the server rather than to one user's.
 */
async function registerDevice(
  deviceToken: string,
  platform: 'ios' | 'macos' = 'ios',
  environment: 'sandbox' | 'production' = 'sandbox',
): Promise<void> {
  const userId = newObjectIdHex();
  run(
    live.db,
    `INSERT INTO users (id, email, email_key, role, created_at) VALUES (?, ?, ?, 'member', ?)`,
    userId,
    `${userId}@example.test`,
    `${userId}@example.test`,
    new Date().toISOString(),
  );
  await registerDeviceToken({
    userId: new ObjectId(userId),
    deviceToken,
    platform,
    environment,
  });
}

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
    setEnvCreds();
    await registerDevice('tok');
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
    await saveApnsSettingsConfig({ enabled: true });
    await registerDevice('tok');
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
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDevice('tok-1');
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
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDevice('tok-1');
    let calls = 0;
    const sent = Promise.withResolvers<void>();
    const trigger = new ApnsPushTrigger({
      coalesceMs: 30,
      senderFactory: () => ({
        sendFileProviderWake: async (): Promise<ApnsSendResult> => {
          calls++;
          sent.resolve();
          return { ok: true };
        },
      }),
    });
    const fires = spyOn(apnsConfig, 'loadApnsSettingsConfig');
    jest.useFakeTimers();
    try {
      trigger.start();
      // Virtual gaps remain below 30 ms even on a stalled CI runner, while
      // the total burst exceeds it. A throttle would fire during the burst.
      for (let cursor = 1; cursor <= 5; cursor++) {
        getChangeBus().publish(fakeChange(new ObjectId(), cursor));
        jest.advanceTimersByTime(20);
      }
      expect(fires).not.toHaveBeenCalled();
      jest.advanceTimersByTime(9);
      expect(fires).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(fires).toHaveBeenCalledTimes(1);
      await sent.promise;
      expect(calls).toBe(1);
    } finally {
      trigger.stop();
      jest.useRealTimers();
      fires.mockRestore();
    }
  });

  it('wakes every registered device, across every user', async () => {
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDevice('tok-a');
    await registerDevice('tok-b', 'macos', 'production');
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
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDevice('tok-1');
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
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDevice('tok-throws');
    await registerDevice('tok-fine');
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
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDevice('dead-tok');
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
    await saveApnsSettingsConfig({ enabled: true });
    setEnvCreds();
    await registerDevice('tok-1');
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
