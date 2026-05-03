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

  async bootstrap(): Promise<{ claimed: boolean }> {
    return firstValueFrom(
      this.http.get<{ claimed: boolean }>("/api/auth/bootstrap"),
    );
  }

  async claim(email: string, deviceLabel: string): Promise<void> {
    const opts = await firstValueFrom(
      this.http.post<any>("/api/auth/register/options", { email }),
    );
    const credential = await startRegistration(opts);
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
    const opts = await firstValueFrom(
      this.http.post<any>("/api/auth/register/options", {
        email,
        invite_code: code,
      }),
    );
    const credential = await startRegistration(opts);
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
    const opts = await firstValueFrom(
      this.http.post<any>("/api/auth/login/options", { email }),
    );
    const credential = await startAuthentication(opts);
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
    const opts = await firstValueFrom(
      this.http.post<any>("/api/auth/credentials/options", {}),
    );
    const credential = await startRegistration(opts);
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
    // Refresh token is set by the server as an httpOnly cookie; not visible to JS.
  }
}
