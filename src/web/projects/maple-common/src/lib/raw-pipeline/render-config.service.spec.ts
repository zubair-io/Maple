// RenderConfigService — the read path for the DB-backed GPU live-render gate
// (#1062). Covers the fetch-then-apply flow, the poll that carries an operator
// flip to already-open clients, and the failure modes that must NOT resurrect
// a killed GPU path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { GpuLiveRenderGate } from './gpu-live-render.gate';
import { RenderConfigService, RENDER_CONFIG_REFRESH_INTERVAL_MS } from './render-config.service';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';
import type { RenderConfigResponse } from './render-config.model';

function body(enabled: boolean, source: 'db' | 'default' = 'db'): RenderConfigResponse {
  return { gpu_live_render_enabled: enabled, source: { gpu_live_render_enabled: source } };
}

describe('RenderConfigService (#1062)', () => {
  let service: RenderConfigService;
  let gate: GpuLiveRenderGate;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TypedStorage.remove(STORAGE_KEYS.GPU_LIVE_RENDER_ENABLED);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(RenderConfigService);
    gate = TestBed.inject(GpuLiveRenderGate);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    ctrl.verify();
  });

  it('applies a fetched false to the gate', async () => {
    const p = service.refresh();
    ctrl.expectOne('/api/render/config').flush(body(false));
    await p;
    expect(gate.enabled()).toBe(false);
    expect(service.config()?.gpu_live_render_enabled).toBe(false);
    expect(service.lastError()).toBeNull();
  });

  it('applies a fetched true to the gate', async () => {
    const p = service.refresh();
    ctrl.expectOne('/api/render/config').flush(body(true));
    await p;
    expect(gate.enabled()).toBe(true);
  });

  it('leaves the gate at its default when the API has never been written', async () => {
    const p = service.refresh();
    ctrl.expectOne('/api/render/config').flush(body(true, 'default'));
    await p;
    expect(gate.enabled()).toBe(true);
    expect(service.config()?.source.gpu_live_render_enabled).toBe('default');
  });

  it('keeps the last known value when a refresh fails — a kill stays killed', async () => {
    const first = service.refresh();
    ctrl.expectOne('/api/render/config').flush(body(false));
    await first;
    expect(gate.enabled()).toBe(false);

    const second = service.refresh();
    ctrl
      .expectOne('/api/render/config')
      .flush({ error: 'nope' }, { status: 503, statusText: 'Unavailable' });
    await second;

    // The GPU path must NOT spring back on because the API blipped.
    expect(gate.enabled()).toBe(false);
    expect(service.lastError()).not.toBeNull();
  });

  it('records the error but leaves the default alone when signed out', async () => {
    const p = service.refresh();
    ctrl
      .expectOne('/api/render/config')
      .flush({ error: 'missing bearer' }, { status: 401, statusText: 'Unauthorized' });
    await p;
    expect(gate.enabled()).toBe(true);
    expect(service.lastError()).not.toBeNull();
  });

  it('init fetches once and then polls, carrying a later flip to an open client', async () => {
    vi.useFakeTimers();
    service.init();

    // Startup fetch: still on.
    ctrl.expectOne('/api/render/config').flush(body(true));
    await Promise.resolve();
    expect(gate.enabled()).toBe(true);

    // Operator flips the switch; the next poll tick picks it up without a
    // reload and without the user touching anything.
    vi.advanceTimersByTime(RENDER_CONFIG_REFRESH_INTERVAL_MS);
    ctrl.expectOne('/api/render/config').flush(body(false));
    await Promise.resolve();
    expect(gate.enabled()).toBe(false);

    service.ngOnDestroy();
    vi.advanceTimersByTime(RENDER_CONFIG_REFRESH_INTERVAL_MS * 3);
    ctrl.verify(); // no further requests after teardown
  });

  it('adopt applies a saved config without re-reading it', async () => {
    service.adopt(body(false));
    expect(gate.enabled()).toBe(false);
    expect(service.config()?.gpu_live_render_enabled).toBe(false);
    expect(service.lastError()).toBeNull();
    ctrl.verify(); // adopting issues no GET
  });

  it('a poll GET that started before a save cannot flip the switch back', async () => {
    // The poll reads "on"…
    const stale = service.refresh();
    const req = ctrl.expectOne('/api/render/config');

    // …the operator saves "off" while that GET is still in flight…
    service.adopt(body(false));
    expect(gate.enabled()).toBe(false);

    // …and the stale response lands afterwards. It must be dropped, not
    // applied: the operator threw the kill switch after the API was read.
    req.flush(body(true));
    await stale;
    expect(gate.enabled()).toBe(false);
    expect(service.config()?.gpu_live_render_enabled).toBe(false);
  });

  it('a poll failure that started before a save does not surface as an error', async () => {
    const stale = service.refresh();
    const req = ctrl.expectOne('/api/render/config');
    service.adopt(body(false));
    req.flush({ error: 'nope' }, { status: 503, statusText: 'Unavailable' });
    await stale;

    // The save succeeded; a superseded poll's failure is not the operator's
    // problem and must not paint an error over a good write.
    expect(service.lastError()).toBeNull();
    expect(gate.enabled()).toBe(false);
  });

  it('init is idempotent — a second call does not start a second poll', async () => {
    vi.useFakeTimers();
    service.init();
    ctrl.expectOne('/api/render/config').flush(body(true));
    await Promise.resolve();

    service.init();
    ctrl.verify(); // the second init issued nothing

    vi.advanceTimersByTime(RENDER_CONFIG_REFRESH_INTERVAL_MS);
    ctrl.expectOne('/api/render/config').flush(body(true));
    await Promise.resolve();
    service.ngOnDestroy();
  });
});
