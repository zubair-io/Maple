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
import { Router } from '@angular/router';
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
  private readonly router = inject(Router);

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
   *
   * Still fetches the server's self-report either way, but returns `null`
   * without the extra candidate-origin probe when the page is ALREADY the
   * candidate (e.g. a reload after a previous switch) — there's nothing to
   * offer.
   */
  async checkAvailable(
    pageProtocol: string = window.location.protocol,
    currentLocation: Pick<Location, 'hostname' | 'port'> = window.location,
  ): Promise<LanSwitchCandidate | null> {
    try {
      const report = await firstValueFrom(
        this.http.get<LocalAddressReport>('/api/network/local-address'),
      );
      const candidate = LanSwitchService.parseCandidate(report);
      if (!candidate) return null;
      if (this.isAlreadyAtCandidate(candidate, pageProtocol, currentLocation)) return null;

      if (pageProtocol === 'https:' && candidate.scheme === 'http') {
        return { origin: candidate.origin };
      }
      const confirmed = await this.probe(candidate.origin, report);
      return confirmed ? { origin: candidate.origin } : null;
    } catch {
      return null;
    }
  }

  /** Extracts the advertised LAN origin from a report, or `null` when the
   * server has none to offer (disabled, or no IP/port resolved). */
  private static parseCandidate(
    report: LocalAddressReport,
  ): { origin: string; scheme: string; ip: string; port: number } | null {
    if (!report.available || !report.ip || !report.port) return null;
    const scheme = report.scheme ?? 'http';
    return {
      origin: `${scheme}://${report.ip}:${report.port}`,
      scheme,
      ip: report.ip,
      port: report.port,
    };
  }

  /**
   * Mints a one-time handoff code and navigates the whole page to the LAN
   * origin, at the SAME app route (path + query) the user is currently on —
   * not the origin's root — so e.g. switching from `/edit/photos/raws/foo.RAF`
   * lands back on that same asset/mode on the LAN origin instead of dropping
   * the user at the default browse state. `provideAuthBootstrap()` on the
   * receiving side only scrubs the `lan_handoff` query param via
   * `history.replaceState`, leaving the rest of the URL untouched, so
   * forwarding the current route here is sufficient — no server-side route
   * payload needed.
   *
   * A top-level navigation is exempt from mixed-content blocking (only
   * subresource fetches are restricted), so this works even from an HTTPS
   * page redirecting to a plain-HTTP LAN address. Returns `false` without
   * navigating when the code couldn't be minted (network error, or the
   * session expired between offering and clicking).
   */
  async switchTo(candidate: LanSwitchCandidate): Promise<boolean> {
    const code = await this.auth.issueLanHandoffCode();
    if (!code) return false;
    const target = new URL(this.router.url, candidate.origin);
    target.searchParams.set('lan_handoff', code);
    this.navigateTo(target.toString());
    return true;
  }

  /** True when the page's own hostname:port already IS the candidate LAN
   * address — nothing to switch to (e.g. a reload after a previous switch). */
  private isAlreadyAtCandidate(
    candidate: { ip: string; port: number },
    pageProtocol: string,
    currentLocation: Pick<Location, 'hostname' | 'port'>,
  ): boolean {
    const currentPort = currentLocation.port || (pageProtocol === 'https:' ? '443' : '80');
    return currentLocation.hostname === candidate.ip && currentPort === String(candidate.port);
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
