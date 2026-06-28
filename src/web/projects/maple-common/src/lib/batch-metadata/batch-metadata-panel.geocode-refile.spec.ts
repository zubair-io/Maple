// batch-metadata-panel.geocode-refile.spec.ts — geocode pipeline and refile-offer
// flows for BatchMetadataPanelComponent (#1616), exercised via Angular TestBed.
//
// Split from batch-metadata-panel.component.spec.ts to stay under the 600-line
// hard budget.  Core visibility / payload / phase-transition tests are in the
// sibling file.
//
// Uses vitest fake timers for the 300ms debounce (same pattern as
// search.component.spec.ts — Angular's fakeAsync is not available without
// zone-testing, which @angular/build:unit-test does not bundle).

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { BatchMetadataPanelComponent } from './batch-metadata-panel.component';
import type { AssetMetadataSnapshot, GeocodeCandidate } from './batch-metadata.types';

// ---------------------------------------------------------------------------
// Host wrapper (shared with the sibling spec)
// ---------------------------------------------------------------------------

@Component({
  standalone: true,
  imports: [BatchMetadataPanelComponent],
  template: `
    <app-batch-metadata-panel
      [visible]="visible()"
      [assetSnapshots]="snapshots()"
      (dismiss)="dismissed = true"
    />
  `,
})
class HostComponent {
  readonly visible = signal(false);
  readonly snapshots = signal<AssetMetadataSnapshot[]>([]);
  dismissed = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPanel(fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>) {
  const debugEl = fixture.debugElement.query(
    (de) => de.componentInstance instanceof BatchMetadataPanelComponent,
  );
  return debugEl.componentInstance as BatchMetadataPanelComponent;
}

/** Advance fake timers past the 300ms debounce and settle Angular signals. */
function drainDebounce(fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>) {
  vi.advanceTimersByTime(350);
  fixture.detectChanges();
}

// ---------------------------------------------------------------------------
// onGeocodeSelect — unconditional field population
// ---------------------------------------------------------------------------

describe('BatchMetadataPanelComponent — onGeocodeSelect', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(HostComponent);
    http = TestBed.inject(HttpTestingController);
    const h = fixture.componentInstance;
    h.visible.set(true);
    h.snapshots.set([{ path: '/a.dng', metadata: {} }]);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('sets lat, lon, city, state, country, countryCode signals and marks all as touched', () => {
    const panel = getPanel(fixture);
    const candidate: GeocodeCandidate = {
      displayName: 'Paris, France',
      lat: 48.8566,
      lon: 2.3522,
      address: {
        city: 'Paris',
        state: 'Île-de-France',
        country: 'France',
        country_code: 'fr',
      },
    };
    panel.onGeocodeSelect(candidate);
    fixture.detectChanges();

    expect(panel.gpsLatitudeVal()).toBe('48.8566');
    expect(panel.gpsLongitudeVal()).toBe('2.3522');
    expect(panel.cityVal()).toBe('Paris');
    expect(panel.stateVal()).toBe('Île-de-France');
    expect(panel.countryVal()).toBe('France');
    expect(panel.countryCodeVal()).toBe('FR'); // uppercased by the real method

    const t = panel.touched();
    expect(t.has('gpsLatitude')).toBe(true);
    expect(t.has('gpsLongitude')).toBe(true);
    expect(t.has('city')).toBe(true);
    expect(t.has('state')).toBe(true);
    expect(t.has('country')).toBe(true);
    expect(t.has('countryCode')).toBe(true);
  });

  it('falls back to town when city is absent, and sets all six fields as touched', () => {
    const panel = getPanel(fixture);
    panel.onGeocodeSelect({
      displayName: 'Smalltown, XX',
      lat: 10,
      lon: 20,
      address: { town: 'Smalltown', country_code: 'xx' },
    });
    fixture.detectChanges();

    expect(panel.cityVal()).toBe('Smalltown');
    expect(panel.countryVal()).toBe(''); // absent → empty (unconditional clear)
    expect(panel.touched().has('country')).toBe(true); // still marked touched
  });

  it('falls back to village when city and town are absent', () => {
    const panel = getPanel(fixture);
    panel.onGeocodeSelect({
      displayName: 'Tinyville',
      lat: 5,
      lon: 10,
      address: { village: 'Tinyville', country_code: 'xx' },
    });
    expect(panel.cityVal()).toBe('Tinyville');
  });

  it('clears the geocode candidate list and query after selection', () => {
    const panel = getPanel(fixture);
    panel.geocodeCandidates.set([{ displayName: 'Some Place', lat: 1, lon: 2, address: {} }]);
    panel.geocodeQuery.set('Some');
    panel.onGeocodeSelect({
      displayName: 'Paris, France',
      lat: 48.8566,
      lon: 2.3522,
      address: { city: 'Paris', country: 'France', country_code: 'fr' },
    });
    expect(panel.geocodeCandidates()).toHaveLength(0);
    expect(panel.geocodeQuery()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Geocode search pipeline — catchError inside switchMap
//
// IMPORTANT: fake timers MUST be active before TestBed.createComponent so the
// component's constructor-time toObservable subscription binds to fake
// setTimeout.  Each test creates its own fixture with fake timers already on.
// ---------------------------------------------------------------------------

describe('BatchMetadataPanelComponent — geocode search pipeline', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(HostComponent);
    http = TestBed.inject(HttpTestingController);
    const h = fixture.componentInstance;
    h.visible.set(true);
    h.snapshots.set([{ path: '/a.dng', metadata: {} }]);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('populates candidates on a successful geocode response', () => {
    const panel = getPanel(fixture);
    panel.geocodeQuery.set('Pari');
    fixture.detectChanges();
    drainDebounce(fixture);

    const call = http.expectOne(
      (req) => req.url.includes('/api/geocode/search') && req.params.get('q') === 'Pari',
    );
    call.flush({
      suggestions: [{ displayName: 'Paris, France', lat: 48.8566, lon: 2.3522, address: {} }],
    });
    fixture.detectChanges();

    expect(panel.geocodeCandidates()).toHaveLength(1);
    expect(panel.geocodeCandidates()[0]!.displayName).toBe('Paris, France');
  });

  it('yields empty candidates and keeps the pipeline alive on HTTP error (catchError inside switchMap)', () => {
    const panel = getPanel(fixture);
    panel.geocodeQuery.set('Pari');
    fixture.detectChanges();
    drainDebounce(fixture);

    const call = http.expectOne((req) => req.url.includes('/api/geocode/search'));
    call.flush('Network error', { status: 500, statusText: 'Internal Server Error' });
    fixture.detectChanges();

    // catchError yields [] — no crash, pipeline still alive.
    expect(panel.geocodeCandidates()).toEqual([]);

    // Second query fires a new HTTP call — pipeline was not killed.
    panel.geocodeQuery.set('Berl');
    fixture.detectChanges();
    drainDebounce(fixture);
    const call2 = http.expectOne(
      (req) => req.url.includes('/api/geocode/search') && req.params.get('q') === 'Berl',
    );
    call2.flush({
      suggestions: [{ displayName: 'Berlin, Germany', lat: 52.52, lon: 13.405, address: {} }],
    });
    fixture.detectChanges();

    expect(panel.geocodeCandidates()[0]!.displayName).toBe('Berlin, Germany');
  });

  it('clears candidates when query is shortened below 2 chars', () => {
    const panel = getPanel(fixture);
    panel.geocodeCandidates.set([{ displayName: 'Paris', lat: 48.8566, lon: 2.3522, address: {} }]);
    panel.onGeocodeQueryInput('P');
    fixture.detectChanges();

    http.expectNone('/api/geocode/search');
    expect(panel.geocodeCandidates()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Refile-offer phase transition (via real onConfirm branching)
// ---------------------------------------------------------------------------

describe('BatchMetadataPanelComponent — refile-offer phase', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>;
  let host: HostComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    host.visible.set(true);
    host.snapshots.set([
      { path: '/a.dng', metadata: {} },
      { path: '/b.dng', metadata: {} },
    ]);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('shows refile-offer when GPS was touched and refileCount > 0', () => {
    const panel = getPanel(fixture);
    panel.gpsLatitudeVal.set('48.8566');
    panel.onFieldChange('gpsLatitude');
    panel.gpsLongitudeVal.set('2.3522');
    panel.onFieldChange('gpsLongitude');
    panel.onApply();
    fixture.detectChanges();
    panel.onConfirm();
    fixture.detectChanges();

    http.expectOne('/api/xmp/batch').flush({
      results: [
        { path: '/a.dng', ok: true },
        { path: '/b.dng', ok: true },
      ],
    });
    fixture.detectChanges();

    const countCall = http.expectOne('/api/backup/refile-count');
    expect(countCall.request.body).toEqual({ paths: ['/a.dng', '/b.dng'] });
    countCall.flush({ count: 3 });
    fixture.detectChanges();

    expect(panel.phase()).toBe('refile-offer');
    expect(panel.refileCount()).toBe(3);
  });

  it('goes to done when GPS touched but refileCount is 0', () => {
    const panel = getPanel(fixture);
    panel.gpsLatitudeVal.set('48.8566');
    panel.onFieldChange('gpsLatitude');
    panel.onApply();
    fixture.detectChanges();
    panel.onConfirm();
    fixture.detectChanges();

    http.expectOne('/api/xmp/batch').flush({
      results: [
        { path: '/a.dng', ok: true },
        { path: '/b.dng', ok: true },
      ],
    });
    fixture.detectChanges();
    http.expectOne('/api/backup/refile-count').flush({ count: 0 });
    fixture.detectChanges();

    expect(panel.phase()).toBe('done');
  });

  it('auto-dismisses without refile offer when GPS was NOT touched', () => {
    const panel = getPanel(fixture);
    panel.cityVal.set('Paris');
    panel.onFieldChange('city');
    panel.onApply();
    fixture.detectChanges();
    panel.onConfirm();
    fixture.detectChanges();

    http.expectOne('/api/xmp/batch').flush({
      results: [
        { path: '/a.dng', ok: true },
        { path: '/b.dng', ok: true },
      ],
    });
    fixture.detectChanges();

    http.expectNone('/api/backup/refile-count');
    expect(panel.phase()).toBe('done');
  });

  it('auto-dismisses when refileCount fetch fails', () => {
    const panel = getPanel(fixture);
    panel.gpsLongitudeVal.set('2.3522');
    panel.onFieldChange('gpsLongitude');
    panel.onApply();
    fixture.detectChanges();
    panel.onConfirm();
    fixture.detectChanges();

    http.expectOne('/api/xmp/batch').flush({
      results: [
        { path: '/a.dng', ok: true },
        { path: '/b.dng', ok: true },
      ],
    });
    fixture.detectChanges();

    http
      .expectOne('/api/backup/refile-count')
      .flush('error', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(panel.phase()).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Refile accept / skip + panel control
// ---------------------------------------------------------------------------

describe('BatchMetadataPanelComponent — refile accept/skip and panel control', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>;
  let host: HostComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    host.visible.set(true);
    host.snapshots.set([{ path: '/a.dng', metadata: {} }]);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('onRefileSkip emits dismiss', () => {
    const panel = getPanel(fixture);
    panel.onRefileSkip();
    fixture.detectChanges();
    expect(host.dismissed).toBe(true);
  });

  it('onRefileAccept POSTs to /api/backup/refile and goes to done on full success', () => {
    const panel = getPanel(fixture);
    panel.phase.set('refile-offer');
    fixture.detectChanges();

    panel.onRefileAccept();
    fixture.detectChanges();

    const call = http.expectOne('/api/backup/refile');
    expect(call.request.method).toBe('POST');
    expect(call.request.body).toEqual({ paths: ['/a.dng'] });
    call.flush({ results: [{ path: '/a.dng', ok: true, outcome: 'moved' }] });
    fixture.detectChanges();

    expect(panel.phase()).toBe('done');
  });

  it('surfaces refile errors and returns to refile-offer on partial failure', () => {
    const panel = getPanel(fixture);
    panel.phase.set('refile-offer');
    fixture.detectChanges();

    panel.onRefileAccept();
    fixture.detectChanges();

    http
      .expectOne('/api/backup/refile')
      .flush({ results: [{ path: '/a.dng', ok: false, error: 'no backup found' }] });
    fixture.detectChanges();

    expect(panel.phase()).toBe('refile-offer');
    expect(panel.refileErrors()).toHaveLength(1);
    expect(panel.refileErrors()[0]!.error).toBe('no backup found');
  });

  it('onClose emits dismiss', () => {
    const panel = getPanel(fixture);
    panel.onClose();
    fixture.detectChanges();
    expect(host.dismissed).toBe(true);
  });

  it('onBackdropClick emits dismiss when not in applying state', () => {
    const panel = getPanel(fixture);
    panel.onBackdropClick();
    fixture.detectChanges();
    expect(host.dismissed).toBe(true);
  });

  it('onBackdropClick does NOT dismiss when in applying state', () => {
    const panel = getPanel(fixture);
    panel.phase.set('applying');
    panel.onBackdropClick();
    expect(host.dismissed).toBe(false);
  });
});
