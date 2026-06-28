// batch-metadata-panel.component.spec.ts — core TestBed suite for
// BatchMetadataPanelComponent (#1616): visibility, mixed-value display, Apply
// button gating, payload building, phase transitions, touchedFieldLabels.
//
// Geocode pipeline and refile-offer flows live in the sibling file:
//   batch-metadata-panel.geocode-refile.spec.ts
//
// Strategy: a thin HostComponent wraps the panel and drives it via
// inputs/events; HTTP calls are flushed inline via HttpTestingController so
// every code path that was previously tested through local helper copies now
// runs through the real component methods.

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BatchMetadataPanelComponent } from './batch-metadata-panel.component';
import type { AssetMetadataSnapshot } from './batch-metadata.types';

// ---------------------------------------------------------------------------
// Host wrapper
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

/** Retrieve the real component instance from inside the host fixture. */
function getPanel(fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>) {
  const debugEl = fixture.debugElement.query(
    (de) => de.componentInstance instanceof BatchMetadataPanelComponent,
  );
  return debugEl.componentInstance as BatchMetadataPanelComponent;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

describe('BatchMetadataPanelComponent', () => {
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
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
  });

  // ── Visibility ─────────────────────────────────────────────────────────────

  describe('visibility', () => {
    it('renders nothing when visible is false', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.bm-backdrop')).toBeNull();
    });

    it('renders the panel when visible is true', () => {
      host.visible.set(true);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.bm-backdrop')).not.toBeNull();
    });
  });

  // ── Asset count label ───────────────────────────────────────────────────────

  describe('asset count display', () => {
    it('shows the count of selected assets in the header', () => {
      host.visible.set(true);
      host.snapshots.set([
        { path: '/a.dng', metadata: {} },
        { path: '/b.dng', metadata: {} },
      ]);
      fixture.detectChanges();
      const countEl = (fixture.nativeElement as HTMLElement).querySelector('.bm-count');
      expect(countEl?.textContent).toContain('2');
    });
  });

  // ── Mixed-value display ─────────────────────────────────────────────────────

  describe('mixed-value display (via real component.mixed computed)', () => {
    beforeEach(() => {
      host.visible.set(true);
      host.snapshots.set([
        { path: '/a.dng', metadata: { city: 'Paris' } },
        { path: '/b.dng', metadata: { city: 'Berlin' } },
      ]);
      fixture.detectChanges();
    });

    it('adds is-mixed class to city input when values differ', () => {
      const cityInput = (fixture.nativeElement as HTMLElement).querySelector(
        '#bm-city',
      ) as HTMLInputElement | null;
      expect(cityInput).not.toBeNull();
      expect(cityInput!.classList.contains('is-mixed')).toBe(true);
    });

    it('sets placeholder to "(mixed)" when city values differ', () => {
      const cityInput = (fixture.nativeElement as HTMLElement).querySelector(
        '#bm-city',
      ) as HTMLInputElement;
      expect(cityInput.placeholder).toBe('(mixed)');
    });

    it('does NOT add is-mixed when both assets agree on city', () => {
      host.snapshots.set([
        { path: '/a.dng', metadata: { city: 'Paris' } },
        { path: '/b.dng', metadata: { city: 'Paris' } },
      ]);
      fixture.detectChanges();
      const cityInput = (fixture.nativeElement as HTMLElement).querySelector(
        '#bm-city',
      ) as HTMLInputElement;
      expect(cityInput.classList.contains('is-mixed')).toBe(false);
    });
  });

  // ── Apply button gating ─────────────────────────────────────────────────────

  describe('Apply button gating', () => {
    beforeEach(() => {
      host.visible.set(true);
      host.snapshots.set([{ path: '/a.dng', metadata: {} }]);
      fixture.detectChanges();
    });

    it('Apply button is disabled when no fields are touched', () => {
      const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
      const applyBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Apply…');
      expect(applyBtn).not.toBeNull();
      expect(applyBtn!.disabled).toBe(true);
    });

    it('Apply button becomes enabled after a field is edited via the real onFieldChange', () => {
      const panel = getPanel(fixture);
      panel.onFieldChange('city');
      fixture.detectChanges();
      const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
      const applyBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'Apply…');
      expect(applyBtn!.disabled).toBe(false);
    });
  });

  // ── Payload — only-touched-fields (via real _buildPayload inside onConfirm) ──

  describe('payload building — only touched fields reach the API', () => {
    beforeEach(() => {
      host.visible.set(true);
      host.snapshots.set([
        { path: '/a.dng', metadata: {} },
        { path: '/b.dng', metadata: {} },
      ]);
      fixture.detectChanges();
    });

    it('sends only the touched city field in the batchApply body', () => {
      const panel = getPanel(fixture);
      panel.cityVal.set('Rome');
      panel.onFieldChange('city');
      // country is set but NOT touched → must stay absent from payload.
      panel.countryVal.set('Italy');

      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();

      const call = http.expectOne('/api/xmp/batch');
      expect(call.request.method).toBe('POST');
      const entries: Array<{ path: string; metadata: Record<string, unknown> }> =
        call.request.body['entries'];

      expect(entries[0]!.metadata['city']).toBe('Rome');
      expect(Object.keys(entries[0]!.metadata)).not.toContain('country');
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.path)).toEqual(['/a.dng', '/b.dng']);

      call.flush({
        results: [
          { path: '/a.dng', ok: true },
          { path: '/b.dng', ok: true },
        ],
      });
      http.expectNone('/api/backup/refile-count');
    });

    it('sends null for an explicitly cleared field', () => {
      const panel = getPanel(fixture);
      panel.cityVal.set('');
      panel.onFieldChange('city');
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();

      const call = http.expectOne('/api/xmp/batch');
      const entries: Array<{ path: string; metadata: Record<string, unknown> }> =
        call.request.body['entries'];
      expect(entries[0]!.metadata['city']).toBeNull();
      call.flush({
        results: [
          { path: '/a.dng', ok: true },
          { path: '/b.dng', ok: true },
        ],
      });
    });

    it('splits comma-separated keywords into an array', () => {
      const panel = getPanel(fixture);
      panel.keywordsVal.set('travel, france, street');
      panel.onFieldChange('keywords');
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();

      const call = http.expectOne('/api/xmp/batch');
      const entries: Array<{ path: string; metadata: Record<string, unknown> }> =
        call.request.body['entries'];
      expect(entries[0]!.metadata['keywords']).toEqual(['travel', 'france', 'street']);
      call.flush({
        results: [
          { path: '/a.dng', ok: true },
          { path: '/b.dng', ok: true },
        ],
      });
    });

    it('sends empty array for an empty keywords string (clears bag)', () => {
      const panel = getPanel(fixture);
      panel.keywordsVal.set('');
      panel.onFieldChange('keywords');
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();

      const call = http.expectOne('/api/xmp/batch');
      const entries: Array<{ path: string; metadata: Record<string, unknown> }> =
        call.request.body['entries'];
      expect(entries[0]!.metadata['keywords']).toEqual([]);
      call.flush({
        results: [
          { path: '/a.dng', ok: true },
          { path: '/b.dng', ok: true },
        ],
      });
    });

    it('sends GPS fields as numbers, not strings', () => {
      const panel = getPanel(fixture);
      panel.gpsLatitudeVal.set('48.8566');
      panel.onFieldChange('gpsLatitude');
      panel.gpsLongitudeVal.set('2.3522');
      panel.onFieldChange('gpsLongitude');
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();

      const call = http.expectOne('/api/xmp/batch');
      const entry = (
        call.request.body['entries'] as Array<{ metadata: Record<string, unknown> }>
      )[0]!;
      expect(typeof entry.metadata['gpsLatitude']).toBe('number');
      expect(entry.metadata['gpsLatitude']).toBe(48.8566);
      expect(typeof entry.metadata['gpsLongitude']).toBe('number');

      call.flush({
        results: [
          { path: '/a.dng', ok: true },
          { path: '/b.dng', ok: true },
        ],
      });
      fixture.detectChanges();
      http.expectOne('/api/backup/refile-count').flush({ count: 0 });
    });

    it('stays on confirm phase and surfaces per-asset errors on batchApply partial failure', () => {
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
          { path: '/b.dng', ok: false, error: 'permission denied' },
        ],
      });
      fixture.detectChanges();

      expect(panel.phase()).toBe('confirm');
      expect(panel.applyErrors()).toHaveLength(1);
      expect(panel.applyErrors()[0]!.error).toBe('permission denied');
    });
  });

  // ── Phase transitions ────────────────────────────────────────────────────────

  describe('phase transitions', () => {
    beforeEach(() => {
      host.visible.set(true);
      host.snapshots.set([{ path: '/a.dng', metadata: {} }]);
      fixture.detectChanges();
    });

    it('onApply with no touched fields is a no-op (stays on form)', () => {
      const panel = getPanel(fixture);
      panel.onApply();
      expect(panel.phase()).toBe('form');
    });

    it('onApply with touched fields transitions to confirm', () => {
      const panel = getPanel(fixture);
      panel.onFieldChange('city');
      panel.onApply();
      expect(panel.phase()).toBe('confirm');
    });

    it('onConfirmCancel returns to form and clears applyErrors', () => {
      const panel = getPanel(fixture);
      panel.applyErrors.set([{ path: '/a.dng', error: 'test' }]);
      panel.phase.set('confirm');
      panel.onConfirmCancel();
      expect(panel.phase()).toBe('form');
      expect(panel.applyErrors()).toHaveLength(0);
    });

    it('onReset clears the touched set and resets field values to the common snapshot value', () => {
      // Snapshot has a common city of "Rome". Toggle visibility off→on so the
      // open-reset effect re-seeds the field signals from these snapshots.
      host.visible.set(false);
      host.snapshots.set([
        { path: '/a.dng', metadata: { city: 'Rome' } },
        { path: '/b.dng', metadata: { city: 'Rome' } },
      ]);
      fixture.detectChanges();
      host.visible.set(true);
      fixture.detectChanges();

      const panel = getPanel(fixture);
      // Open-reset effect seeded cityVal from the common value.
      expect(panel.cityVal()).toBe('Rome');

      // User overrides + touches the field.
      panel.cityVal.set('Paris');
      panel.onFieldChange('city');
      expect(panel.touched().size).toBeGreaterThan(0);

      panel.onReset();
      fixture.detectChanges();

      // Touched set cleared AND the field value reverts to the common snapshot value.
      expect(panel.touched().size).toBe(0);
      expect(panel.cityVal()).toBe('Rome');
    });

    it('onReset clears an overridden field back to empty when the snapshot has no common value', () => {
      const panel = getPanel(fixture);
      // Snapshot metadata is empty → seeded value is ''.
      panel.cityVal.set('Paris');
      panel.onFieldChange('city');
      expect(panel.cityVal()).toBe('Paris');

      panel.onReset();
      fixture.detectChanges();

      expect(panel.touched().size).toBe(0);
      expect(panel.cityVal()).toBe('');
    });
  });

  // ── touchedFieldLabels computed ─────────────────────────────────────────────

  describe('touchedFieldLabels computed', () => {
    it('returns human-readable labels for touched fields', () => {
      host.visible.set(true);
      host.snapshots.set([{ path: '/a.dng', metadata: {} }]);
      fixture.detectChanges();

      const panel = getPanel(fixture);
      panel.onFieldChange('city');
      panel.onFieldChange('gpsLatitude');
      fixture.detectChanges();

      const labels = panel.touchedFieldLabels();
      expect(labels).toContain('City');
      expect(labels).toContain('GPS Latitude');
    });
  });
});
