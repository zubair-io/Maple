// API_BASE_URL — base URL prefix for BunApiBackendService requests.
// Defaults to '/api' so Self-Hosted deployments work behind a reverse proxy
// without rebuilding the bundle. Override in app.config.ts when needed.
//
// A LAN-address preference is handled by redirecting the whole page to the
// server's LAN origin (see network/lan-switch.service.ts) rather than by
// swapping this value at runtime — WebAuthn requires a secure context, which
// a plain-HTTP LAN address can't provide, so the API base must always match
// the origin the page itself was loaded from.

import { InjectionToken } from '@angular/core';

export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '/api',
});
