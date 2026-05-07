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

  /// Returns true when the page is running inside the Maple Apple shell's
  /// WKWebView. The native side injects a `WKScriptMessageHandler` named
  /// `maple` via `WKUserContentController.add(_:name:)` before loading
  /// the URL — a normal browser tab leaves
  /// `window.webkit.messageHandlers.maple` undefined.
  get isNativeShell(): boolean {
    const w = window as unknown as {
      webkit?: { messageHandlers?: { maple?: unknown } };
    };
    return typeof w.webkit?.messageHandlers?.maple !== "undefined";
  }

  /// Hands tokens to the native shell after a successful auth ceremony.
  /// No-op outside the shell. The native side reads these and persists
  /// them via `TokenStore` + per-server `AuthSession`.
  private postNativeAuthSuccess(r: any): void {
    if (!this.isNativeShell) return;
    const w = window as unknown as {
      webkit: { messageHandlers: { maple: { postMessage: (m: unknown) => void } } };
    };
    w.webkit.messageHandlers.maple.postMessage({
      type: "auth_success",
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      user: r.user,
    });
  }
}
