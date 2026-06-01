// ObservabilityService — unit coverage for the init / refresh / rewire
// contract (#713 review follow-up). We drive the service with INACTIVE configs
// (enabled:false) so no real OpenTelemetry providers spin up — the branches
// under test (cache warm-start, background refresh, changed-vs-unchanged
// re-wire decision, error handling) all run before `buildRuntime`, which is
// only reached for an active config. The active export path is exercised in
// the browser/e2e harness, not here, to keep these tests free of global OTel
// state.

// Load the JIT compiler so partially-compiled @angular libs resolve when these
// specs run under plain vitest (outside the AOT `ng test` linker pipeline).
import '@angular/compiler';
import { describe, it, expect, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';

import { ObservabilityService } from './observability.service';
import {
  OBSERVABILITY_CONFIG_CACHE,
  InMemoryObservabilityConfigCache,
  type ObservabilityConfigCache,
} from './observability-config-cache';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { API_BASE_URL } from '../api/api-base-url.token';
import { AuthService } from '../auth/auth.service';
import type { ObservabilityConfigResponse } from './observability-config.model';

/** Build the service against an explicit injector — no Angular TestBed env
 * needed, so this runs under plain vitest. `inject()` in the service's field
 * initializers resolves from `injector` because we construct inside its
 * injection context. */
function makeService(
  cache: ObservabilityConfigCache,
  api: Pick<BunApiBackendService, 'getObservabilityConfig'>,
): ObservabilityService {
  const injector = Injector.create({
    providers: [
      { provide: OBSERVABILITY_CONFIG_CACHE, useValue: cache },
      { provide: BunApiBackendService, useValue: api },
      { provide: API_BASE_URL, useValue: '/api' },
      // The service injects AuthService only to read `bearer` when building the
      // OTLP exporter headers; these tests never reach an active export (configs
      // are inactive), so a stub with a null bearer is sufficient.
      { provide: AuthService, useValue: { bearer: null } },
    ],
  });
  return runInInjectionContext(injector, () => new ObservabilityService());
}

function makeConfig(
  overrides: Partial<ObservabilityConfigResponse> = {},
): ObservabilityConfigResponse {
  return {
    enabled: false,
    endpoint: null,
    ingestion_key_set: false,
    service_namespace: 'maple',
    traces_enabled: true,
    logs_enabled: true,
    metrics_enabled: false,
    sample_ratio: 1,
    source: { endpoint: 'unset', ingestion_key: 'unset' },
    ...overrides,
  };
}

describe('ObservabilityService', () => {
  let cache: InMemoryObservabilityConfigCache;
  // Swappable per test: the next value `getObservabilityConfig()` yields.
  let apiResponse: () => Observable<ObservabilityConfigResponse>;
  let svc: ObservabilityService;

  beforeEach(() => {
    cache = new InMemoryObservabilityConfigCache();
    apiResponse = () => of(makeConfig());
    svc = makeService(cache, { getObservabilityConfig: () => apiResponse() });
  });

  it('warm-starts from the IndexedDB cache on init', async () => {
    const cached = makeConfig({ service_namespace: 'cached-ns' });
    await cache.put(cached);
    // Make the background refresh a no-op echo of the cache so the assertion
    // is stable regardless of refresh timing.
    apiResponse = () => of(cached);

    await svc.init();

    expect(svc.config()?.service_namespace).toBe('cached-ns');
    expect(svc.cachedAt()).not.toBeNull();
    // Inactive config → providers never built.
    expect(svc.initialized()).toBe(false);
  });

  it('falls back to a network refresh on a cache miss', async () => {
    const fromServer = makeConfig({ service_namespace: 'server-ns' });
    apiResponse = () => of(fromServer);

    await svc.init();
    // init() fires refresh() without awaiting; let the microtask settle.
    await svc.refresh();

    expect(svc.config()?.service_namespace).toBe('server-ns');
    expect(svc.lastError()).toBeNull();
  });

  it('records the error and leaves prior config intact when refresh fails', async () => {
    const seed = makeConfig({ service_namespace: 'seed' });
    await cache.put(seed);
    apiResponse = () => of(seed);
    await svc.init();

    apiResponse = () => throwError(() => new Error('signoz unreachable'));
    await svc.refresh();

    expect(svc.lastError()).toBe('signoz unreachable');
    // The previously-applied config is not wiped by a failed refresh.
    expect(svc.config()?.service_namespace).toBe('seed');
  });

  it('re-applies config when the wiring changed', async () => {
    const a = makeConfig({ service_namespace: 'a' });
    await cache.put(a);
    apiResponse = () => of(a);
    await svc.init();

    const b = makeConfig({ service_namespace: 'b' });
    apiResponse = () => of(b);
    await svc.refresh();

    expect(svc.config()?.service_namespace).toBe('b');
    expect(svc.cachedAt()).not.toBeNull();
    // Persisted back through the cache so the next launch warm-starts on it.
    expect((await cache.get())?.config.service_namespace).toBe('b');
  });

  it('keeps the freshest object even when the wiring is unchanged', async () => {
    const a = makeConfig({
      service_namespace: 'a',
      source: { endpoint: 'unset', ingestion_key: 'unset' },
    });
    await cache.put(a);
    apiResponse = () => of(a);
    await svc.init();

    // Same wiring, different provenance — should still land on the signal.
    const aPrime = makeConfig({
      service_namespace: 'a',
      source: { endpoint: 'db', ingestion_key: 'unset' },
    });
    apiResponse = () => of(aPrime);
    await svc.refresh();

    expect(svc.config()?.source['endpoint']).toBe('db');
    expect(svc.lastError()).toBeNull();
  });

  it('init is idempotent — a second call does not re-read the cache', async () => {
    let reads = 0;
    const counting = new InMemoryObservabilityConfigCache();
    const origGet = counting.get.bind(counting);
    counting.get = async () => {
      reads += 1;
      return origGet();
    };
    const svc2 = makeService(counting, { getObservabilityConfig: () => of(makeConfig()) });
    await svc2.init();
    await svc2.init();

    expect(reads).toBe(1);
  });
});
