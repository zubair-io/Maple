// presets.service.spec.ts — PresetsService CRUD over both backends
// (#1115, spec §10.7).
//
// Self-hosted: HTTP against /api/presets via HttpTestingController.
// Hosted: the user-preset store — jsdom has no IndexedDB, so
// `createHostedUserPresetStore` hands back the in-memory variant; the
// service behavior under test is identical either way.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { BUILTIN_PRESETS } from './builtin-presets';
import type { Preset } from './preset-model';
import { buildApplyPatch } from './preset-model';
import { PresetsService } from './presets.service';

function wireRow(id: string, name: string, fields: Record<string, number | string>) {
  return {
    id,
    schemaVersion: 1,
    name,
    fields,
    createdAt: '2026-06-10T00:00:00Z',
    updatedAt: '2026-06-10T00:00:00Z',
  };
}

describe('PresetsService (self-hosted backend)', () => {
  let svc: PresetsService;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      ],
    });
    svc = TestBed.inject(PresetsService);
    ctrl = TestBed.inject(HttpTestingController);
  });

  afterEach(() => ctrl.verify());

  it('exposes the bundled built-ins without any backend call', () => {
    expect(svc.builtins).toBe(BUILTIN_PRESETS);
    expect(svc.builtins.length).toBeGreaterThan(0);
    expect(svc.builtins.every((p) => p.builtIn)).toBe(true);
  });

  it('load() GETs /api/presets and sorts case-insensitively', async () => {
    const p = svc.load();
    ctrl.expectOne('/api/presets').flush({
      presets: [wireRow('a1', 'zebra', { contrast: 1 }), wireRow('b2', 'Alpha', { exposure: 1 })],
    });
    await p;
    expect(svc.loaded()).toBe(true);
    expect(svc.error()).toBeNull();
    expect(svc.userPresets().map((x) => x.name)).toEqual(['Alpha', 'zebra']);
    expect(svc.userPresets().every((x) => !x.builtIn)).toBe(true);
  });

  it('load() surfaces a failure on error() and still flips loaded()', async () => {
    const p = svc.load();
    ctrl
      .expectOne('/api/presets')
      .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    await p;
    expect(svc.loaded()).toBe(true);
    expect(svc.error()).toBe('boom');
    expect(svc.userPresets()).toEqual([]);
  });

  it('save() POSTs the sparse document and appends the created preset', async () => {
    const p = svc.save('  My Sunset  ', { contrast: -25 });
    const req = ctrl.expectOne('/api/presets');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      schemaVersion: 1,
      name: 'My Sunset',
      fields: { contrast: -25 },
    });
    req.flush(wireRow('c3', 'My Sunset', { contrast: -25 }), {
      status: 201,
      statusText: 'Created',
    });
    const created = await p;
    expect(created).not.toBeNull();
    expect(created!.id).toBe('c3');
    expect(svc.userPresets().map((x) => x.name)).toEqual(['My Sunset']);
    expect(svc.error()).toBeNull();
  });

  it('save() surfaces the server 409 message and returns null', async () => {
    const p = svc.save('Dupe', { contrast: 1 });
    ctrl
      .expectOne('/api/presets')
      .flush({ error: 'a preset named "Dupe" already exists' }, { status: 409, statusText: 'C' });
    expect(await p).toBeNull();
    expect(svc.error()).toBe('a preset named "Dupe" already exists');
  });

  it('save() refuses invalid names, built-in collisions, and empty fields locally', async () => {
    expect(await svc.save('   ', { contrast: 1 })).toBeNull();
    expect(svc.error()).toContain('Preset names');

    expect(await svc.save('monochrome', { contrast: 1 })).toBeNull();
    expect(svc.error()).toContain('built-in');

    expect(await svc.save('Fine Name', {})).toBeNull();
    expect(svc.error()).toContain('No edited settings');
    // No HTTP request was issued for any of these — afterEach verify()s.
  });

  it('delete() DELETEs by id and drops the row; built-ins refuse', async () => {
    const loadP = svc.load();
    ctrl.expectOne('/api/presets').flush({ presets: [wireRow('d4', 'Doomed', { exposure: 1 })] });
    await loadP;

    const target = svc.userPresets()[0];
    const p = svc.delete(target);
    const req = ctrl.expectOne('/api/presets/d4');
    expect(req.request.method).toBe('DELETE');
    req.flush({ ok: true });
    expect(await p).toBe(true);
    expect(svc.userPresets()).toEqual([]);

    expect(await svc.delete(BUILTIN_PRESETS[0])).toBe(false);
    expect(svc.error()).toContain('Built-in');
  });
});

describe('PresetsService (hosted backend, in-memory store)', () => {
  let svc: PresetsService;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      ],
    });
    svc = TestBed.inject(PresetsService);
    ctrl = TestBed.inject(HttpTestingController);
  });

  // The hosted backend must never issue HTTP traffic.
  afterEach(() => ctrl.verify());

  it('round-trips imported calibration and unknown fields without applying them', async () => {
    const fields = {
      lens_profile: `lcp1-ack:${'a'.repeat(64)}`,
      future_lens_hint: 'opaque data',
      exposure: 0.5,
    };
    const saved = await svc.save('Imported record', fields);
    expect(saved).not.toBeNull();
    await svc.load();
    const stored = svc.userPresets().find((preset) => preset.id === saved!.id)!;
    expect(stored.fields).toEqual(fields);
    expect(buildApplyPatch(stored.fields)).toEqual({ exposure: 0.5 });
    expect(stored.fields).toEqual(fields);
  });

  it('saves, lists, and deletes through the store without HTTP', async () => {
    await svc.load();
    expect(svc.loaded()).toBe(true);
    expect(svc.userPresets()).toEqual([]);

    const created = await svc.save('Beta', { contrast: 5 });
    expect(created).not.toBeNull();
    await svc.save('alpha', { exposure: 0.5 });
    expect(svc.userPresets().map((x) => x.name)).toEqual(['alpha', 'Beta']);

    // The store (not just the signal) holds the rows: a re-load round-trips.
    await svc.load();
    expect(svc.userPresets().map((x) => x.name)).toEqual(['alpha', 'Beta']);

    expect(await svc.delete(created as Preset)).toBe(true);
    await svc.load();
    expect(svc.userPresets().map((x) => x.name)).toEqual(['alpha']);
  });

  it('rejects duplicate names case-insensitively', async () => {
    await svc.load();
    await svc.save('Golden Hour', { contrast: 5 });
    expect(await svc.save('golden hour', { contrast: 9 })).toBeNull();
    expect(svc.error()).toContain('already exists');
  });
});
