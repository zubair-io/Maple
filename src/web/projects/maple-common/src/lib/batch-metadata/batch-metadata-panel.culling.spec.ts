// batch-metadata-panel.culling.spec.ts — culling-section TestBed suite for
// BatchMetadataPanelComponent (#1614): rating/flag/colorLabel controls,
// leave-unchanged-vs-clear semantics, the rating NaN/out-of-range guard, and
// payload building for culling fields.
//
// Split out of batch-metadata-panel.component.spec.ts to stay under the
// per-file line budget; reuses the same HostComponent + getPanel pattern.

import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BatchMetadataPanelComponent } from './batch-metadata-panel.component';
import type { AssetMetadataSnapshot } from './batch-metadata.types';

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

/** Retrieve the real component instance from inside the host fixture. */
function getPanel(fixture: ReturnType<typeof TestBed.createComponent<HostComponent>>) {
  const debugEl = fixture.debugElement.query(
    (de) => de.componentInstance instanceof BatchMetadataPanelComponent,
  );
  return debugEl.componentInstance as BatchMetadataPanelComponent;
}

describe('BatchMetadataPanelComponent — culling', () => {
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

  describe('culling section', () => {
    it('renders the Culling section when panel is open', async () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: { rating: 3 } }]);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.bm-section-title')?.textContent).toContain('Culling');
    });

    it('shows (mixed) placeholder for rating when values differ', () => {
      host.visible.set(true);
      host.snapshots.set([
        { address: 'photos:a.dng', metadata: { rating: 2 } },
        { address: 'photos:b.dng', metadata: { rating: 4 } },
      ]);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const ratingInput = el.querySelector<HTMLInputElement>('#bm-rating');
      expect(ratingInput?.placeholder).toBe('(mixed)');
    });

    it('includes rating in the payload when touched (via real onRatingInput)', async () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onRatingInput('4');
      fixture.detectChanges();
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();
      const req = http.expectOne('/api/xmp/batch');
      const body = req.request.body as { entries: Array<{ metadata: { rating: number } }> };
      expect(body.entries[0]!.metadata.rating).toBe(4);
      req.flush({ results: [{ address: 'photos:a.dng', ok: true }] });
    });

    it('rating 0 is a valid clear (touched, sent as 0)', () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: { rating: 3 } }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onRatingInput('0');
      fixture.detectChanges();
      expect(panel.touched().has('rating')).toBe(true);
    });

    it('empty rating input does NOT touch the field (no NaN→null clear)', () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: { rating: 3 } }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      // Type then clear the input back to empty (a common transient state).
      panel.onRatingInput('4');
      expect(panel.touched().has('rating')).toBe(true);
      panel.onRatingInput('');
      expect(panel.touched().has('rating')).toBe(false);
    });

    it('out-of-range / non-integer rating does NOT touch the field', () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onRatingInput('7');
      expect(panel.touched().has('rating')).toBe(false);
      panel.onRatingInput('2.5');
      expect(panel.touched().has('rating')).toBe(false);
      panel.onRatingInput('-1');
      expect(panel.touched().has('rating')).toBe(false);
    });

    it('includes flag=pick in the payload when touched (via real onFlagChange)', async () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onFlagChange('pick');
      fixture.detectChanges();
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();
      const req = http.expectOne('/api/xmp/batch');
      const body = req.request.body as { entries: Array<{ metadata: { flag: string } }> };
      expect(body.entries[0]!.metadata.flag).toBe('pick');
      req.flush({ results: [{ address: 'photos:a.dng', ok: true }] });
    });

    it('flag "leave unchanged" is a no-op (not touched)', () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      // Touch then return to the leave-unchanged option.
      panel.onFlagChange('pick');
      expect(panel.touched().has('flag')).toBe(true);
      panel.onFlagChange('');
      expect(panel.touched().has('flag')).toBe(false);
    });

    it('flag explicit-clear maps to unflagged (touched)', async () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onFlagChange('__clear__');
      expect(panel.touched().has('flag')).toBe(true);
      fixture.detectChanges();
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();
      const req = http.expectOne('/api/xmp/batch');
      const body = req.request.body as { entries: Array<{ metadata: { flag: string } }> };
      expect(body.entries[0]!.metadata.flag).toBe('unflagged');
      req.flush({ results: [{ address: 'photos:a.dng', ok: true }] });
    });

    it('colorLabel "leave unchanged" is a no-op (not touched)', () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onColorLabelChange('red');
      expect(panel.touched().has('colorLabel')).toBe(true);
      panel.onColorLabelChange('');
      expect(panel.touched().has('colorLabel')).toBe(false);
    });

    it('colorLabel explicit-clear sends null (touched)', async () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onColorLabelChange('__clear__');
      expect(panel.touched().has('colorLabel')).toBe(true);
      fixture.detectChanges();
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();
      const req = http.expectOne('/api/xmp/batch');
      const body = req.request.body as {
        entries: Array<{ metadata: { colorLabel: string | null } }>;
      };
      expect(body.entries[0]!.metadata.colorLabel).toBeNull();
      req.flush({ results: [{ address: 'photos:a.dng', ok: true }] });
    });

    it('colorLabel value is sent as-is (touched)', async () => {
      host.visible.set(true);
      host.snapshots.set([{ address: 'photos:a.dng', metadata: {} }]);
      fixture.detectChanges();
      const panel = getPanel(fixture);
      panel.onColorLabelChange('green');
      fixture.detectChanges();
      panel.onApply();
      fixture.detectChanges();
      panel.onConfirm();
      fixture.detectChanges();
      const req = http.expectOne('/api/xmp/batch');
      const body = req.request.body as {
        entries: Array<{ metadata: { colorLabel: string | null } }>;
      };
      expect(body.entries[0]!.metadata.colorLabel).toBe('green');
      req.flush({ results: [{ address: 'photos:a.dng', ok: true }] });
    });
  });
});
