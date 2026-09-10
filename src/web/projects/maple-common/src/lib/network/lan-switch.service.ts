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
  /** A confirmed managed HTTPS origin can be preferred without an HTTP downgrade. */
  automatic?: boolean;
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
      if (!report.available) return null;
      const candidates = [
        ...(report.https?.scheme === 'https'
          ? [{ ...report.https, available: true, managed: true }]
          : []),
        { ...report, managed: false },
      ];
      for (const endpoint of candidates) {
        const candidate = LanSwitchService.parseCandidate(endpoint);
        if (!candidate) continue;
        if (this.isAlreadyAtCandidate(candidate, pageProtocol, currentLocation)) return null;
        // Browsers cannot probe an HTTP LAN IP from an HTTPS page. Preserve
        // the existing explicit switch for this fallback instead of silently
        // navigating to a potentially unreachable/insecure address.
        const offer = await this.offerCandidate(candidate, endpoint, pageProtocol);
        if (offer) return offer;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async offerCandidate(
    candidate: { origin: string; scheme: string },
    endpoint: LocalAddressReport & { managed: boolean },
    pageProtocol: string,
  ): Promise<LanSwitchCandidate | null> {
    if (pageProtocol === 'https:' && candidate.scheme === 'http')
      return { origin: candidate.origin };
    if (!(await this.probe(candidate.origin, endpoint))) return null;
    return endpoint.managed
      ? { origin: candidate.origin, automatic: true }
      : { origin: candidate.origin };
  }

  private static validPort(port: number | undefined): port is number {
    return Number.isInteger(port) && port !== undefined && port >= 1 && port <= 65535;
  }

  private static isHostOnly(url: URL, host: string): boolean {
    return (
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      url.hostname === host.toLowerCase()
    );
  }

  private static formatHost(ip: string): string {
    return ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
  }

  /** Extracts the advertised LAN origin from a report, or `null` when the
   * server has none to offer (disabled, or no IP/port resolved). */
  private static parseCandidate(
    report: LocalAddressReport,
  ): { origin: string; scheme: string; ip: string; port: number } | null {
    if (!report.available || !report.ip || !LanSwitchService.validPort(report.port)) return null;
    const scheme = report.scheme ?? 'http';
    if (scheme !== 'http' && scheme !== 'https') return null;
    const host = LanSwitchService.formatHost(report.ip);
    try {
      const url = new URL(`${scheme}://${host}:${report.port}`);
      if (!LanSwitchService.isHostOnly(url, host)) return null;
      // `url.hostname` is what `location.hostname` will report after the hop
      // (lowercased, brackets kept); a mixed-case server value would otherwise
      // never match "already here" and re-hop on every load.
      return {
        origin: `${scheme}://${host}:${report.port}`,
        scheme,
        ip: url.hostname,
        port: report.port,
      };
    } catch {
      return null;
    }
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
    // Normalize the router URL to a guaranteed app-internal path with exactly
    // one leading slash BEFORE resolving it against the candidate origin: a
    // path starting with `//` would be parsed by `new URL` as
    // PROTOCOL-RELATIVE (`//evil.example/x` → `http://evil.example/x`),
    // redirecting the one-time handoff code off-origin.
    const appPath = `/${this.router.url.replace(/^\/+/, '')}`;
    const target = new URL(appPath, candidate.origin);
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
      return (
        body.available === true &&
        [body, body.https].some(
          (endpoint) =>
            endpoint !== undefined &&
            endpoint.ip === expected.ip &&
            endpoint.port === expected.port &&
            (endpoint.scheme ?? 'http') === (expected.scheme ?? 'http'),
        )
      );
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
