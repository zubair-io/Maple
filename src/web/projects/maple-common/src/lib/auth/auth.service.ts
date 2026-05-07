import { Injectable, signal, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { firstValueFrom } from "rxjs";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

export interface AuthUser {
  id: string;
  email: string;
  role: "owner" | "member";
}

@Injectable({ providedIn: "root" })
export class AuthService {
  private http = inject(HttpClient);
  readonly user = signal<AuthUser | null>(null);
  private accessToken: string | null = null;

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
      const cb = params.get("native_callback");
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
    return this.user()?.role === "owner";
  }
  get isSignedIn(): boolean {
    return this.user() !== null;
  }

  async bootstrap(): Promise<{ claimed: boolean; dev_login_enabled: boolean }> {
    return firstValueFrom(
      this.http.get<{ claimed: boolean; dev_login_enabled: boolean }>(
        "/api/auth/bootstrap",
      ),
    );
  }

  async devSignIn(email = "dev@maple.local"): Promise<void> {
    const r = await firstValueFrom(
      this.http.post<any>("/api/auth/dev-login", { email }),
    );
    this.acceptTokens(r);
  }

  async claim(email: string, deviceLabel: string): Promise<void> {
    const optionsJSON = await firstValueFrom(
      this.http.post<any>("/api/auth/register/options", { email }),
    );
    const credential = await startRegistration({ optionsJSON });
    const r = await firstValueFrom(
      this.http.post<any>("/api/auth/register/verify", {
        email,
        device_label: deviceLabel,
        credential,
      }),
    );
    this.acceptTokens(r);
  }

  async join(
    server: string,
    email: string,
    code: string,
    deviceLabel: string,
  ): Promise<void> {
    // Server URL is implicit (same-origin). For a remote server, an optional baseUrl param could be added.
    const optionsJSON = await firstValueFrom(
      this.http.post<any>("/api/auth/register/options", {
        email,
        invite_code: code,
      }),
    );
    const credential = await startRegistration({ optionsJSON });
    const r = await firstValueFrom(
      this.http.post<any>("/api/auth/register/verify", {
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
      this.http.post<any>("/api/auth/login/options", { email }),
    );
    const credential = await startAuthentication({ optionsJSON });
    const r = await firstValueFrom(
      this.http.post<any>("/api/auth/login/verify", { email, credential }),
    );
    this.acceptTokens(r);
  }

  async refresh(): Promise<boolean> {
    try {
      const r = await firstValueFrom(
        this.http.post<{ access_token: string }>("/api/auth/refresh", {}),
      );
      this.accessToken = r.access_token;
      return true;
    } catch {
      this.user.set(null);
      this.accessToken = null;
      return false;
    }
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.http.post("/api/auth/logout", {}));
    } catch {
      /* ignore */
    }
    this.accessToken = null;
    this.user.set(null);
  }

  async loadMe(): Promise<void> {
    const r = await firstValueFrom(this.http.get<any>("/api/auth/me"));
    this.user.set(r.user);
  }

  async addCredential(deviceLabel: string): Promise<void> {
    const optionsJSON = await firstValueFrom(
      this.http.post<any>("/api/auth/credentials/options", {}),
    );
    const credential = await startRegistration({ optionsJSON });
    await firstValueFrom(
      this.http.post<any>("/api/auth/credentials/verify", {
        device_label: deviceLabel,
        credential,
      }),
    );
  }

  async deleteCredential(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<any>(`/api/auth/credentials/${encodeURIComponent(id)}`),
    );
  }

  async listInvites(): Promise<any[]> {
    const r = await firstValueFrom(
      this.http.get<{ invites: any[] }>("/api/auth/invites"),
    );
    return r.invites ?? [];
  }

  async createInvite(
    email: string,
  ): Promise<{ code: string; expires_at: string }> {
    return firstValueFrom(
      this.http.post<{ code: string; expires_at: string }>(
        "/api/auth/invites",
        { email },
      ),
    );
  }

  async rescindInvite(code: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<any>(
        `/api/auth/invites/${encodeURIComponent(code)}`,
      ),
    );
  }

  private acceptTokens(r: any): void {
    this.accessToken = r.access_token;
    this.user.set(r.user);
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
    params.set("access_token", r.access_token);
    params.set("refresh_token", r.refresh_token);
    params.set("user_id", r.user.id);
    params.set("user_email", r.user.email);
    params.set("user_role", r.user.role);
    window.location.href = `${scheme}://auth-success?${params.toString()}`;
  }
}
