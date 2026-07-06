// LanSwitchService — decides whether to offer "switch to local network",
// and performs the switch via a top-level redirect.
//
// WebAuthn (passkeys) requires a secure context (`https:` or exactly
// `http://localhost`) — a LAN IP like `192.168.1.42` over plain HTTP does
// not qualify. So a signed-in session can only ever be ESTABLISHED on the
// public HTTPS domain; this service hands that session to the SAME
// browser's LAN-origin page via a one-time code carried in a full-page
// redirect (see AuthService.issueLanHandoffCode/redeemLanHandoff), rather
// than silently swapping API_BASE_URL underneath the page — a background
// fetch to a plain-HTTP LAN address from an HTTPS page is blocked by mixed
// content anyway, so that approach never actually activates in the
// realistic case of a public HTTPS reverse proxy/tunnel.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import type { LocalAddressReport } from './local-address-report.model';

export interface LanSwitchCandidate {
  /** e.g. "http://192.168.1.42:3000" */
  origin: string;
}

@Injectable({ providedIn: 'root' })
export class LanSwitchService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  /**
   * Checks whether the server has a LAN address to offer. Confirms
   * reachability with a background probe when doing so isn't guaranteed to
   * be blocked by the browser; otherwise (an HTTPS page + an HTTP
   * candidate — the realistic case behind a public reverse proxy/tunnel,
   * where mixed content blocks ANY background fetch to the candidate)
   * trusts the server's self-report unconfirmed, since we structurally
   * cannot verify it from that context. A genuinely unreachable address in
   * that case just fails the eventual top-level navigation with the
   * browser's own "can't reach this page" error — an acceptable, well
   * understood failure mode for an explicit user action.
   */
  async checkAvailable(
    pageProtocol: string = window.location.protocol,
  ): Promise<LanSwitchCandidate | null> {
    try {
      const report = await firstValueFrom(
        this.http.get<LocalAddressReport>('/api/network/local-address'),
      );
      if (!report.available || !report.ip || !report.port) return null;
      const candidateScheme = report.scheme ?? 'http';
      const origin = `${candidateScheme}://${report.ip}:${report.port}`;

      if (pageProtocol === 'https:' && candidateScheme === 'http') {
        return { origin };
      }
      const confirmed = await this.probe(origin, report);
      return confirmed ? { origin } : null;
    } catch {
      return null;
    }
  }

  /**
   * Mints a one-time handoff code and navigates the whole page to the LAN
   * origin. A top-level navigation is exempt from mixed-content blocking
   * (only subresource fetches are restricted), so this works even from an
   * HTTPS page redirecting to a plain-HTTP LAN address. Returns `false`
   * without navigating when the code couldn't be minted (network error, or
   * the session expired between offering and clicking).
   */
  async switchTo(candidate: LanSwitchCandidate): Promise<boolean> {
    const code = await this.auth.issueLanHandoffCode();
    if (!code) return false;
    this.navigateTo(`${candidate.origin}/?lan_handoff=${encodeURIComponent(code)}`);
    return true;
  }

  /** Re-hits the SAME report endpoint at the candidate origin, requiring it
   * to confirm the same ip/port — not just any 200 — so we don't offer a
   * switch to a stale or reassigned address. */
  private async probe(origin: string, expected: LocalAddressReport): Promise<boolean> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`${origin}/api/network/local-address`, { signal: ctrl.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as LocalAddressReport;
      return body.available === true && body.ip === expected.ip && body.port === expected.port;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Seam for tests. */
  private navigateTo(url: string): void {
    window.location.href = url;
  }
}
