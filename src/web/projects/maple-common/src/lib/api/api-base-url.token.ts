// API_BASE_URL — base URL prefix for BunApiBackendService requests.
// Defaults to '/api' so Self-Hosted deployments work behind a reverse proxy
// without rebuilding the bundle.
//
// Reads from ApiBaseUrlStore rather than a static value: the
// `provideNetworkPreferenceBootstrap()` initializer (see
// `network-preference-bootstrap.ts`) can populate the store with the
// server's LAN address before this token is first injected, so self-hosted
// clients transparently prefer the LAN address over the public URL when
// they're on the same network.

import { InjectionToken, inject } from '@angular/core';
import { ApiBaseUrlStore } from './api-base-url-store';

export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => inject(ApiBaseUrlStore).value,
});
