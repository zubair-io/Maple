/**
 * APNs HTTP/2 provider client — token-based (`.p8`) authentication, sending
 * the File Provider "wake and pull" push Apple documents for
 * `NSFileProviderReplicatedExtension` (registered via `PKPushRegistry` with
 * `PKPushType.fileProvider`, per Apple's "Using push notifications to
 * signal changes" guide). This is the whole payload — the extension does
 * not read anything out of the push, it just wakes and re-pulls the
 * `?since=` cursor, so the body is the minimum valid JSON object.
 *
 * No retry logic lives here — same policy as `cloudflare/r2-client.ts`:
 * retries are a caller concern. The one thing this module DOES decide is
 * whether a rejection means the token is permanently dead (`shouldPrune`),
 * because only the sender knows Apple's status-code/reason vocabulary;
 * pruning the row itself is the caller's job (`apns/push-trigger.ts`).
 */

import { SignJWT, importPKCS8 } from 'jose';
import type { ApnsEnvCredentials } from './apns-config.repo.ts';
import type { ApnsEnvironment } from '../db/schema.ts';

/**
 * Push topic for a File Provider wake signal: `<bundle-id>.pushkit.fileprovider`,
 * Apple's documented convention for a PushKit `.fileProvider` registration
 * (mirrors the well-known `<bundle-id>.voip` topic for VoIP pushes). See
 * `docs/apple.md` § "File Provider and Quick Look" for the bundle id.
 */
export const APNS_FILE_PROVIDER_TOPIC = 'app.justmaple.aperture.pushkit.fileprovider';

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

// Apple caps a provider token's validity at 60 minutes and asks providers
// not to generate a fresh one more than once every 20 minutes. Refreshing
// at 50 minutes keeps every send comfortably inside the validity window
// with no risk of straddling the boundary mid-request.
const TOKEN_REUSE_SECONDS = 50 * 60;

export type ApnsSendResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      reason: string;
      /** True when Apple's response means this device token will never
       * succeed again (unregistered / malformed) and the caller should
       * delete its registration row rather than retry. */
      shouldPrune: boolean;
    };

// Apple's JSON error body is `{ "reason": "<CamelCaseReason>" }`.
const PRUNE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

export class ApnsSender {
  // Caches the in-flight SIGNING PROMISE, not just the resolved JWT. A
  // burst fans out to every device for a library via `Promise.allSettled`
  // (see `push-trigger.ts`), so several `sendFileProviderWake` calls can
  // reach `providerToken()` before the first `importPKCS8`/`sign()` pair
  // has resolved. Caching only the final string left that whole window
  // uncached — every concurrent caller would see `cachedToken: null` and
  // sign its own token, and Apple rejects more than one provider-token
  // generation per ~20 minutes (`TooManyProviderTokenUpdates`). Because the
  // promise is stored synchronously, before `signProviderToken`'s first
  // `await` yields, every caller in the same synchronous burst is
  // guaranteed to observe the same cached promise.
  private cachedToken: { promise: Promise<string>; issuedAtSeconds: number } | null = null;

  constructor(
    private readonly creds: ApnsEnvCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private providerToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && now - this.cachedToken.issuedAtSeconds < TOKEN_REUSE_SECONDS) {
      return this.cachedToken.promise;
    }
    const promise = this.signProviderToken(now);
    this.cachedToken = { promise, issuedAtSeconds: now };
    // A signing failure must not poison the cache for the rest of the
    // reuse window — drop it (only if nothing newer already replaced it)
    // so the next call retries from scratch instead of replaying the same
    // rejection for ~50 minutes.
    promise.catch(() => {
      if (this.cachedToken?.promise === promise) this.cachedToken = null;
    });
    return promise;
  }

  private async signProviderToken(now: number): Promise<string> {
    const key = await importPKCS8(this.creds.privateKeyPem, 'ES256');
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.creds.keyId })
      .setIssuer(this.creds.teamId)
      .setIssuedAt(now)
      .sign(key);
  }

  /**
   * Send one File Provider wake push to `deviceToken` in `environment`.
   * Never throws on an APNs-level rejection (network failure still throws —
   * that's a transport error, not a decision the caller needs to branch
   * on); inspect the returned `ApnsSendResult` instead.
   */
  async sendFileProviderWake(
    deviceToken: string,
    environment: ApnsEnvironment,
  ): Promise<ApnsSendResult> {
    const host = environment === 'production' ? PRODUCTION_HOST : SANDBOX_HOST;
    const token = await this.providerToken();
    const res = await this.fetchImpl(`${host}/3/device/${deviceToken}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'apns-topic': APNS_FILE_PROVIDER_TOPIC,
        // PushKit push type for a File Provider wake — not "alert" or
        // "background": this is the type Apple's File Provider guide
        // documents for signaling extension freshness.
        'apns-push-type': 'fileprovider',
        // Background-priority delivery; there is no user-visible alert to
        // schedule immediately.
        'apns-priority': '5',
        'content-type': 'application/json',
      },
      // Minimum valid JSON body — the extension only cares that it woke,
      // not about payload content (it re-pulls via the cursor endpoint).
      body: '{}',
    });
    if (res.ok) return { ok: true };
    const reason = await readReason(res);
    return {
      ok: false,
      status: res.status,
      reason,
      shouldPrune: res.status === 410 || PRUNE_REASONS.has(reason),
    };
  }
}

async function readReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: string };
    return body.reason ?? `http_${res.status}`;
  } catch {
    return `http_${res.status}`;
  }
}
