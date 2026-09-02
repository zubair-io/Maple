/**
 * ApnsPushTrigger — turns `ChangeBus` publishes into coalesced APNs
 * File Provider wake pushes (#1025).
 *
 * Subscribes to the exact same in-process bus the SSE route
 * (`routes/changes.ts`) reads from, so a push fires for every change that
 * would also have reached a held SSE connection — worker-emitted changes
 * included, since `ChangeFeedTailer` republishes those onto this same bus.
 * SSE keeps working unmodified alongside this; push is purely an additional
 * "wake up and pull" signal, never a replacement for the cursor/backfill
 * machinery.
 *
 * Coalescing is SERVER-WIDE, not per-library: a File Provider domain
 * covers a whole connected server (`FileProviderDomainController
 * .domainIdentifier(for:)` keys on scheme+host+port only), with every
 * library on that server surfacing as a sub-tree inside that one domain
 * — so a device holds exactly one push registration per server, and a
 * change to ANY library on it should wake the same registration. A burst
 * of changes anywhere on the server (e.g. an import of 200 files) must
 * therefore produce one wake per device, not 200.
 *
 * This is a true debounce, not a throttle: every change RESETS the one
 * pending timer, so the wake fires once, `coalesceMs` after the burst
 * goes quiet — not once per `coalesceMs` for the duration of a long
 * burst. That is deliberate even though it means a burst longer than
 * `coalesceMs` delays the wake until it finishes: the eventual wake
 * pulls everything since the client's cursor in one shot (the `?since=`
 * pull is cumulative, not per-event), so a single delayed-but-complete
 * wake is strictly better than N redundant ones mid-import.
 */

import { getChangeBus } from '../runtime/change-bus.ts';
import type { AssetChangeWithId } from '../db/schema.ts';
import { child as childLogger } from '../log.ts';
import {
  loadApnsCredentialsFromEnv,
  loadApnsSettingsConfig,
  resolveApnsSettingsConfig,
  type ApnsEnvCredentials,
} from './apns-config.repo.ts';
import { listAllDeviceTokens, pruneDeviceTokens } from './apns-devices.repo.ts';
import { ApnsSender } from './apns-sender.ts';

const log = childLogger('apns-push-trigger');

export interface ApnsPushTriggerOptions {
  /** Coalescing window, in ms. Default 2000 — long enough to absorb a
   * realistic write burst (an import, a batch rename) into one wake,
   * short enough that "push instead of a live SSE socket" still feels
   * immediate to a human waiting on Finder. */
  coalesceMs?: number;
  /** Injected for tests. Production reuses ONE `ApnsSender` across every
   * burst for as long as the credentials it was built from stay the same
   * (see `senderFor` below) — a fresh sender per burst would throw away
   * `ApnsSender`'s own ~50-minute provider-JWT cache every ~2 seconds,
   * which is exactly the `TooManyProviderTokenUpdates` footgun Apple's
   * rate limit exists to catch. */
  senderFactory?: (creds: ApnsEnvCredentials) => Pick<ApnsSender, 'sendFileProviderWake'>;
}

export class ApnsPushTrigger {
  private readonly coalesceMs: number;
  private readonly senderFactory: (
    creds: ApnsEnvCredentials,
  ) => Pick<ApnsSender, 'sendFileProviderWake'>;
  /** The one pending debounce timer, server-wide — see the class doc
   * comment for why this isn't keyed per library. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The one sender in use across bursts, plus the credential values it
   * was built from — rebuilt only when those values actually change
   * (env-var credentials in practice only change on redeploy, i.e. never
   * within one process's lifetime, but comparing costs nothing). */
  private cachedSender: {
    creds: ApnsEnvCredentials;
    sender: Pick<ApnsSender, 'sendFileProviderWake'>;
  } | null = null;
  /** Log the missing-credentials warning once per process, not once per
   * coalesced burst — on a busy server that would spam the log and bury
   * real warnings behind a burst-frequency repeat of the same message. */
  private warnedMissingCredentials = false;

  constructor(opts: ApnsPushTriggerOptions = {}) {
    this.coalesceMs = Math.max(0, opts.coalesceMs ?? 2000);
    this.senderFactory = opts.senderFactory ?? ((creds) => new ApnsSender(creds));
  }

  private senderFor(creds: ApnsEnvCredentials): Pick<ApnsSender, 'sendFileProviderWake'> {
    const cached = this.cachedSender;
    if (
      cached &&
      cached.creds.keyId === creds.keyId &&
      cached.creds.teamId === creds.teamId &&
      cached.creds.privateKeyPem === creds.privateKeyPem
    ) {
      return cached.sender;
    }
    const sender = this.senderFactory(creds);
    this.cachedSender = { creds, sender };
    return sender;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = getChangeBus().subscribe((ev) => this.onChange(ev));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }

  private onChange(_ev: AssetChangeWithId): void {
    // Debounce, not throttle: an in-flight timer is cancelled and
    // rescheduled from now, so a steady stream of changes keeps pushing
    // the fire time out rather than letting it fire every `coalesceMs`
    // for the duration of the burst (see the class doc comment for why
    // that trade-off is the right one here). Every change counts,
    // regardless of `folder_id` — a folder-less change (e.g. a rescan)
    // still means "something changed", and there is no per-library
    // registration to route it to anyway.
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.fire().catch((err) => {
        log.error({ err }, 'push fan-out failed');
      });
    }, this.coalesceMs);
  }

  private async fire(): Promise<void> {
    const resolved = resolveApnsSettingsConfig(await loadApnsSettingsConfig());
    if (!resolved.enabled) return;
    const creds = loadApnsCredentialsFromEnv();
    if (!creds) {
      if (!this.warnedMissingCredentials) {
        this.warnedMissingCredentials = true;
        log.warn(
          'APNs push enabled but MAPLE_APNS_* credentials are unset; skipping (SSE fallback still active) — this warning will not repeat for the life of this process',
        );
      }
      return;
    }
    this.warnedMissingCredentials = false;
    const devices = await listAllDeviceTokens();
    if (devices.length === 0) return;
    const sender = this.senderFor(creds);
    const settled = await Promise.allSettled(
      devices.map((d) => sender.sendFileProviderWake(d.device_token, d.environment)),
    );
    // Collected across the whole fan-out rather than pruned per-device
    // inline, so a burst that rejects many devices at once issues ONE
    // `deleteMany` instead of one round trip per rejected device.
    const toPrune: string[] = [];
    settled.forEach((outcome, i) => {
      const device = devices[i]!;
      if (outcome.status === 'rejected') {
        // A transport/JWT-signing failure, not an APNs-level rejection —
        // `sendFileProviderWake` only rejects the promise for those (see
        // its own doc comment). Distinct log line so this doesn't read as
        // "APNs said no" when it's actually "we never reached APNs".
        log.error(
          { err: outcome.reason, device: device.device_token.slice(0, 8) },
          'push send failed (transport/signing)',
        );
        return;
      }
      const result = outcome.value;
      if (result.ok) return;
      log.warn(
        { status: result.status, reason: result.reason, device: device.device_token.slice(0, 8) },
        'push rejected',
      );
      if (result.shouldPrune) toPrune.push(device.device_token);
    });
    if (toPrune.length > 0) await pruneDeviceTokens(toPrune);
  }
}

let _instance: ApnsPushTrigger | null = null;

export function getApnsPushTrigger(): ApnsPushTrigger {
  if (!_instance) _instance = new ApnsPushTrigger();
  return _instance;
}
