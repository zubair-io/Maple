import { Injectable, signal, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

/// Custom URL schemes we will hand a one-time auth code to. The Apple shell
/// registers `maple-app://`; we honor ONLY known schemes, so a page loaded with
/// an attacker-supplied `?native_callback=…` is ignored (#856).
const NATIVE_SCHEME_ALLOWLIST = new Set(['maple-app']);

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
      const cb = new URLSearchParams(window.location.search).get('native_callback');
      // Allowlist — not just format. An attacker-named scheme is ignored, so a
      // malicious page can't make us redirect a code anywhere but the app (#856).
      if (cb && NATIVE_SCHEME_ALLOWLIST.has(cb.toLowerCase())) return cb.toLowerCase();
    } catch {
      /* SSR / non-browser contexts */
    }
    return null;
  })();

  /// PKCE challenge + opaque CSRF state the Apple shell passed on the initial
  /// URL. The shell keeps the verifier private; we only forward the challenge to
  /// the server and echo the state back in the redirect (#856).
  private readonly _nativePkce: { codeChallenge: string; state: string } | null = (() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const codeChallenge = p.get('code_challenge') ?? '';
      const state = p.get('state') ?? '';
      // base64url S256 challenge (43 chars) + a bounded opaque state.
      if (/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) && /^[A-Za-z0-9_-]{8,256}$/.test(state)) {
        return { codeChallenge, state };
      }
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

  /**
   * Sign in with a passkey (#1377) — pure passkey, no email. The browser offers
   * the user's discoverable passkeys for this site and the server identifies the
   * account from the chosen credential, so there is nothing to type.
   */
  async signIn(): Promise<void> {
    const optionsJSON = await firstValueFrom(this.http.post<any>('/api/auth/login/options', {}));
    const credential = await startAuthentication({ optionsJSON });
    const r = await firstValueFrom(this.http.post<any>('/api/auth/login/verify', { credential }));
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

  /**
   * Fresh WebAuthn step-up ceremony (#861) → a short-lived step-up token.
   * Sensitive actions (add/remove credential, create/rescind invite) require
   * this on top of the access token, so a leaked short-lived access token can't
   * escalate into persistent access. The browser prompts for the passkey.
   */
  private async stepUp(): Promise<string> {
    const optionsJSON = await firstValueFrom(this.http.post<any>('/api/auth/step-up/options', {}));
    const credential = await startAuthentication({ optionsJSON });
    const r = await firstValueFrom(
      this.http.post<{ step_up_token: string }>('/api/auth/step-up/verify', { credential }),
    );
    return r.step_up_token;
  }

  async addCredential(deviceLabel: string): Promise<void> {
    const stepUp = await this.stepUp();
    const optionsJSON = await firstValueFrom(
      this.http.post<any>('/api/auth/credentials/options', {}),
    );
    const credential = await startRegistration({ optionsJSON });
    await firstValueFrom(
      this.http.post<any>(
        '/api/auth/credentials/verify',
        { device_label: deviceLabel, credential },
        { headers: { 'X-Step-Up': stepUp } },
      ),
    );
  }

  async deleteCredential(id: string): Promise<void> {
    const stepUp = await this.stepUp();
    await firstValueFrom(
      this.http.delete<any>(`/api/auth/credentials/${encodeURIComponent(id)}`, {
        headers: { 'X-Step-Up': stepUp },
      }),
    );
  }

  async listInvites(): Promise<any[]> {
    const r = await firstValueFrom(this.http.get<{ invites: any[] }>('/api/auth/invites'));
    return r.invites ?? [];
  }

  async createInvite(email: string): Promise<{ code: string; expires_at: string }> {
    const stepUp = await this.stepUp();
    return firstValueFrom(
      this.http.post<{ code: string; expires_at: string }>(
        '/api/auth/invites',
        { email },
        { headers: { 'X-Step-Up': stepUp } },
      ),
    );
  }

  async rescindInvite(code: string): Promise<void> {
    const stepUp = await this.stepUp();
    await firstValueFrom(
      this.http.delete<any>(`/api/auth/invites/${encodeURIComponent(code)}`, {
        headers: { 'X-Step-Up': stepUp },
      }),
    );
  }

  private acceptTokens(r: any): void {
    this.accessToken = r.access_token;
    this.user.set(r.user);
    // Let peer tabs adopt the new session without their own ceremony.
    this.broadcast({ type: 'token', access_token: r.access_token });
    // Inside the Apple shell, hand the app a one-time code (never the tokens).
    // Fire-and-forget: the redirect happens once the server issues the code.
    void this.postNativeAuthSuccess();
  }

  /// Returns true when the page is running inside an
  /// `ASWebAuthenticationSession` started by the Maple Apple shell.
  /// Detected via the `?native_callback=<scheme>` query parameter the
  /// Apple side adds to the initial URL.
  get isNativeShell(): boolean {
    return this._nativeCallbackScheme !== null;
  }

  /// After a successful ceremony inside the Apple shell, hand the app a
  /// short-lived one-time CODE (never tokens). The shell redeems the code with
  /// its private PKCE verifier at `/api/auth/native-code/redeem`. The redirect
  /// is captured privately by the host `ASWebAuthenticationSession`.
  private async postNativeAuthSuccess(): Promise<void> {
    const scheme = this._nativeCallbackScheme;
    const pkce = this._nativePkce;
    // No scheme → a normal browser tab. Missing/invalid PKCE → an Apple shell
    // that predates the code flow; we do NOT fall back to putting tokens in the
    // redirect URL, so its sign-in simply won't complete until it's updated.
    if (!scheme || !pkce) return;
    try {
      const { code } = await firstValueFrom(
        this.http.post<{ code: string }>('/api/auth/native-code', {
          code_challenge: pkce.codeChallenge,
          state: pkce.state,
        }),
      );
      const params = new URLSearchParams({ code, state: pkce.state });
      this.navigateTo(`${scheme}://auth-success?${params.toString()}`);
    } catch {
      /* code issuance failed — do not leak tokens via a fallback redirect */
    }
  }

  /// Seam for the post-auth native redirect, captured privately by the host
  /// ASWebAuthenticationSession. Overridable in tests.
  private navigateTo(url: string): void {
    window.location.href = url;
  }
}
