import { Injectable, signal, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

export interface AuthUser {
  id: string;
  email: string;
  role: 'owner' | 'member';
}

/**
 * Outcome of a refresh attempt.
 *  - `refreshed`: we now hold a valid access token; callers may retry.
 *  - `rejected`:  the server genuinely rejected our refresh credential
 *                 (cookie missing/expired/revoked). The session is cleared
 *                 — this is a real sign-out.
 *  - `transient`: the refresh could not be completed for a reason that is
 *                 NOT an auth failure (offline, network blip, 5xx, rate
 *                 limit). The session is PRESERVED so a momentary hiccup
 *                 doesn't punt a signed-in user back to the login screen.
 */
export type RefreshOutcome = 'refreshed' | 'rejected' | 'transient';

/**
 * How long a refresh token broadcast by a peer tab is considered usable
 * before we'd rather mint our own. Access tokens live for 30 days, so a
 * few-second window is plenty to dedupe a cold-load stampede without ever
 * adopting a stale credential.
 */
const PEER_TOKEN_TTL_MS = 5_000;

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  readonly user = signal<AuthUser | null>(null);
  private accessToken: string | null = null;

  /**
   * In-tab coalescing: a single refresh runs at a time within this tab and
   * every concurrent caller awaits the same promise.
   */
  private inflight: Promise<RefreshOutcome> | null = null;

  /**
   * Cross-tab coordination. All tabs of one browser share a single httpOnly
   * refresh cookie, and that cookie ROTATES on every `/api/auth/refresh`. If
   * two tabs refresh concurrently with the same cookie, the server's
   * reuse-detection revokes the entire token chain and signs the user out
   * everywhere. We serialize refreshes across tabs with the Web Locks API
   * and gossip freshly-minted access tokens over a BroadcastChannel so peers
   * can skip a redundant rotation.
   */
  private readonly channel: BroadcastChannel | null = (() => {
    try {
      if (typeof BroadcastChannel === 'undefined') return null;
      return new BroadcastChannel('maple-auth');
    } catch {
      return null;
    }
  })();
  private peerToken: string | null = null;
  private peerTokenAt = 0;

  constructor() {
    this.channel?.addEventListener('message', (ev: MessageEvent) => {
      const msg = ev.data as { type?: string; access_token?: string } | null;
      if (!msg) return;
      if (msg.type === 'token' && typeof msg.access_token === 'string') {
        // A peer refreshed (or signed in). Adopt its token so our next
        // request authenticates without racing the rotating cookie.
        this.accessToken = msg.access_token;
        this.peerToken = msg.access_token;
        this.peerTokenAt = Date.now();
      } else if (msg.type === 'signout') {
        // A peer signed out (or its refresh was genuinely rejected). Drop our
        // session too so every tab reflects the same auth state.
        this.accessToken = null;
        this.peerToken = null;
        this.user.set(null);
      }
    });
  }

  /// Custom URL scheme to redirect to after auth success when the page
  /// was loaded inside an `ASWebAuthenticationSession` from the Apple
  /// app. Read once at service construction; preserved across in-app
  /// navigations (the session captures the redirect by scheme, not by
  /// the path the user navigates through).
  ///
  /// `null` in a normal browser tab.
  private readonly _nativeCallbackScheme: string | null = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const cb = params.get('native_callback');
      // Restrict to a-z digits and `-` to avoid javascript:// or other
      // shenanigans being smuggled in.
      if (cb && /^[a-z][a-z0-9-]*$/i.test(cb)) return cb;
    } catch {
      /* SSR / non-browser contexts */
    }
    return null;
  })();

  get bearer(): string | null {
    return this.accessToken;
  }
  get isOwner(): boolean {
    return this.user()?.role === 'owner';
  }
  get isSignedIn(): boolean {
    return this.user() !== null;
  }

  async bootstrap(): Promise<{ claimed: boolean; dev_login_enabled: boolean }> {
    return firstValueFrom(
      this.http.get<{ claimed: boolean; dev_login_enabled: boolean }>('/api/auth/bootstrap'),
    );
  }

  async devSignIn(email = 'dev@maple.local'): Promise<void> {
    const r = await firstValueFrom(this.http.post<any>('/api/auth/dev-login', { email }));
    this.acceptTokens(r);
  }

  async claim(email: string, deviceLabel: string): Promise<void> {
    const optionsJSON = await firstValueFrom(
      this.http.post<any>('/api/auth/register/options', { email }),
    );
    const credential = await startRegistration({ optionsJSON });
    const r = await firstValueFrom(
      this.http.post<any>('/api/auth/register/verify', {
        email,
        device_label: deviceLabel,
        credential,
      }),
    );
    this.acceptTokens(r);
  }

  async join(server: string, email: string, code: string, deviceLabel: string): Promise<void> {
    // Server URL is implicit (same-origin). For a remote server, an optional baseUrl param could be added.
    const optionsJSON = await firstValueFrom(
      this.http.post<any>('/api/auth/register/options', {
        email,
        invite_code: code,
      }),
    );
    const credential = await startRegistration({ optionsJSON });
    const r = await firstValueFrom(
      this.http.post<any>('/api/auth/register/verify', {
        email,
        device_label: deviceLabel,
        invite_code: code,
        credential,
      }),
    );
    this.acceptTokens(r);
  }

  async signIn(email: string): Promise<void> {
    const optionsJSON = await firstValueFrom(
      this.http.post<any>('/api/auth/login/options', { email }),
    );
    const credential = await startAuthentication({ optionsJSON });
    const r = await firstValueFrom(
      this.http.post<any>('/api/auth/login/verify', { email, credential }),
    );
    this.acceptTokens(r);
  }

  async refresh(): Promise<RefreshOutcome> {
    // Coalesce concurrent callers within this tab onto one attempt.
    this.inflight ??= this.runRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * Serialize the network refresh across tabs via the Web Locks API. Without
   * the lock, two tabs that both cold-load (and so both lack an in-memory
   * access token) would `/refresh` with the same cookie and trip the
   * server's reuse-detection, signing the user out everywhere.
   */
  private runRefresh(): Promise<RefreshOutcome> {
    // Cast through `unknown` so we don't merge with the DOM `LockManager`
    // typing (its `request` overloads resolve to `Promise<any>` and break
    // generic inference on the callback return).
    const locks = (
      globalThis.navigator as unknown as {
        locks?: { request<T>(name: string, cb: () => Promise<T>): Promise<T> };
      }
    )?.locks;
    if (locks?.request) {
      return locks.request('maple-auth-refresh', () => this.refreshLocked());
    }
    return this.refreshLocked();
  }

  private async refreshLocked(): Promise<RefreshOutcome> {
    // A peer tab may have refreshed while we queued for the lock. Adopt its
    // token instead of rotating the cookie again.
    if (this.peerToken && Date.now() - this.peerTokenAt < PEER_TOKEN_TTL_MS) {
      this.accessToken = this.peerToken;
      return 'refreshed';
    }
    try {
      const r = await firstValueFrom(
        this.http.post<{ access_token: string }>('/api/auth/refresh', {}),
      );
      this.accessToken = r.access_token;
      this.broadcast({ type: 'token', access_token: r.access_token });
      return 'refreshed';
    } catch (err) {
      // Only a genuine 401 means the refresh credential itself was rejected
      // (missing / expired / revoked) — that's a real sign-out. Anything else
      // (offline = status 0, 5xx, 429 rate-limit, …) is transient: keep the
      // session so a blip doesn't bounce the user to the login screen.
      if (err instanceof HttpErrorResponse && err.status === 401) {
        this.user.set(null);
        this.accessToken = null;
        this.peerToken = null;
        this.broadcast({ type: 'signout' });
        return 'rejected';
      }
      return 'transient';
    }
  }

  private broadcast(msg: { type: 'token'; access_token: string } | { type: 'signout' }): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* channel closed / unsupported */
    }
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } catch {
      /* ignore */
    }
    this.accessToken = null;
    this.peerToken = null;
    this.user.set(null);
    this.broadcast({ type: 'signout' });
  }

  async loadMe(): Promise<void> {
    const r = await firstValueFrom(this.http.get<any>('/api/auth/me'));
    this.user.set(r.user);
  }

  async addCredential(deviceLabel: string): Promise<void> {
    const optionsJSON = await firstValueFrom(
      this.http.post<any>('/api/auth/credentials/options', {}),
    );
    const credential = await startRegistration({ optionsJSON });
    await firstValueFrom(
      this.http.post<any>('/api/auth/credentials/verify', {
        device_label: deviceLabel,
        credential,
      }),
    );
  }

  async deleteCredential(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<any>(`/api/auth/credentials/${encodeURIComponent(id)}`));
  }

  async listInvites(): Promise<any[]> {
    const r = await firstValueFrom(this.http.get<{ invites: any[] }>('/api/auth/invites'));
    return r.invites ?? [];
  }

  async createInvite(email: string): Promise<{ code: string; expires_at: string }> {
    return firstValueFrom(
      this.http.post<{ code: string; expires_at: string }>('/api/auth/invites', { email }),
    );
  }

  async rescindInvite(code: string): Promise<void> {
    await firstValueFrom(this.http.delete<any>(`/api/auth/invites/${encodeURIComponent(code)}`));
  }

  private acceptTokens(r: any): void {
    this.accessToken = r.access_token;
    this.user.set(r.user);
    // Let peer tabs adopt the new session without their own ceremony.
    this.broadcast({ type: 'token', access_token: r.access_token });
    // Refresh token is set by the server as an httpOnly cookie; not
    // visible to JS in a normal browser context. The same `/login/verify`
    // and `/register/verify` responses ALSO include `refresh_token` in
    // the JSON body so the native shell can capture it via the bridge.
    this.postNativeAuthSuccess(r);
  }

  /// Returns true when the page is running inside an
  /// `ASWebAuthenticationSession` started by the Maple Apple shell.
  /// Detected via the `?native_callback=<scheme>` query parameter the
  /// Apple side adds to the initial URL.
  get isNativeShell(): boolean {
    return this._nativeCallbackScheme !== null;
  }

  /// Redirects to the native callback URL after a successful auth
  /// ceremony. The host `ASWebAuthenticationSession` captures the
  /// redirect by matching the scheme — the URL never reaches Safari's
  /// regular history or any other app. Tokens are short-lived JWTs;
  /// the URL is local-process-only.
  private postNativeAuthSuccess(r: any): void {
    const scheme = this._nativeCallbackScheme;
    if (!scheme) return;
    const params = new URLSearchParams();
    params.set('access_token', r.access_token);
    params.set('refresh_token', r.refresh_token);
    params.set('user_id', r.user.id);
    params.set('user_email', r.user.email);
    params.set('user_role', r.user.role);
    window.location.href = `${scheme}://auth-success?${params.toString()}`;
  }
}
