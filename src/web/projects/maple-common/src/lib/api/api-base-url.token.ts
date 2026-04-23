// API_BASE_URL — base URL prefix for BunApiBackendService requests.
// Defaults to '/api' so Self-Hosted deployments work behind a reverse proxy
// without rebuilding the bundle. Override in app.config.ts when needed.

import { InjectionToken } from '@angular/core';

export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => '/api',
});
