import { EnvironmentProviders, provideAppInitializer, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, type Observable } from 'rxjs';
import { ApiBaseUrlStore } from '../api/api-base-url-store';
import type { LocalAddressReport } from './local-address-report.model';

/**
 * Prefers the server's LAN address over the public URL the page loaded
 * from, when the client is actually on the same network as the server.
 *
 * Self-hosted Maple is commonly reachable two ways at once: a public URL
 * (reverse proxy, dyndns hostname, Cloudflare Tunnel) and, when the client
 * happens to be on the same LAN as the server, a faster direct path. This
 * asks the page's own origin (always same-origin — a relative fetch) what
 * its LAN address is, then decides whether switching `ApiBaseUrlStore` to
 * that address is actually usable:
 *
 *   - A page loaded over HTTPS cannot silently background-fetch a
 *     plain-HTTP LAN address — browsers block that as mixed content, and
 *     Chrome's Private Network Access adds further restriction on any page
 *     fetching a private-network address at all. Rather than force a
 *     jarring full-page redirect to work around this, we simply no-op:
 *     the app keeps using the public URL, with no feature effect and no
 *     breakage.
 *   - Otherwise, a short reachability probe confirms the LAN address is
 *     actually reachable (different network, VPN, or an unreachable server
 *     all degrade to the same no-op) before switching.
 *
 * `AuthService`'s session-bootstrap calls (login/refresh/logout) are
 * hardcoded relative `/api/auth/...` paths and do NOT go through
 * `API_BASE_URL` — they always stay pinned to the page's own origin, which
 * is what keeps the httpOnly-cookie-based refresh flow working regardless
 * of where this points `BunApiBackendService`'s traffic.
 *
 * Pure-ish and dependency-injected (rather than reading `window`/`fetch`
 * directly) so it's unit-testable without a browser DOM: `pageProtocol` and
 * `fetchImpl` default to the real globals but can be overridden in tests.
 * Every failure is swallowed — this must never throw, since
 * `provideNetworkPreferenceBootstrap()` below blocks app bootstrap on it.
 */
export async function applyNetworkPreference(
  http: { get(url: string): Observable<LocalAddressReport> },
  store: ApiBaseUrlStore,
  pageProtocol: string = typeof window !== 'undefined' ? window.location.protocol : 'https:',
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const report = await firstValueFrom(http.get('/api/network/local-address'));
    if (!report.available || !report.ip || !report.port) return;

    const candidateScheme = report.scheme ?? 'http';
    const candidateOrigin = `${candidateScheme}://${report.ip}:${report.port}`;

    // Mixed-content pre-check: an HTTPS page cannot background-fetch a
    // plain-HTTP origin. Skip the doomed fetch (and the console error it
    // would log) and no-op immediately.
    if (pageProtocol === 'https:' && candidateScheme === 'http') {
      return;
    }

    // Reachability probe: re-hit the SAME endpoint at the candidate origin,
    // which doubles as confirmation we reached the right server (not just
    // some device occupying that IP:port), not only "something answered".
    // Any rejection here — mixed content slipping past the pre-check, a
    // Private Network Access preflight rejection, or plain unreachability —
    // collapses to the same no-op.
    const reachable = await probeReachable(
      `${candidateOrigin}/api/network/local-address`,
      fetchImpl,
    );
    if (!reachable) return;

    store.setLocal(`${candidateOrigin}/api`);
  } catch {
    /* never block boot, and never switch on any failure */
  }
}

async function probeReachable(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = 1500,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as LocalAddressReport;
    return body.available === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Like `provideAuthBootstrap()`, this BLOCKS bootstrap: `provideAppInitializer`
 * awaits the returned promise, so `API_BASE_URL` (and everything that injects
 * it) sees the final value on first injection.
 */
export function provideNetworkPreferenceBootstrap(): EnvironmentProviders {
  return provideAppInitializer(() => {
    const store = inject(ApiBaseUrlStore);
    const http = inject(HttpClient);
    return applyNetworkPreference({ get: (url) => http.get<LocalAddressReport>(url) }, store);
  });
}
