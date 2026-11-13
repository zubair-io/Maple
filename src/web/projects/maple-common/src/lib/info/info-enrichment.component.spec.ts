import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import type { Asset } from '../models/asset';
import { LibraryStateService } from '../state/library-state.service';
import { InfoEnrichmentComponent } from './info-enrichment.component';

// The production browser audit treats an XHR the app aborts itself as a bug
// (#5388): restoring the focused photo's sidecar replaces its `Asset` record,
// and that alone used to cancel the in-flight detail request and send it again.
describe('InfoEnrichmentComponent detail request', () => {
  const asset = { id: 'library:photo.dng', filename: 'photo.dng' } as Asset;
  const focusedAsset = signal<Asset | null>(asset);
  const requests: string[] = [];
  let cancelled = 0;

  beforeEach(() => {
    requests.length = 0;
    cancelled = 0;
    focusedAsset.set(asset);
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryStateService, useValue: { focusedAsset, apiIdFor: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        {
          provide: BunApiBackendService,
          useValue: {
            getWorkerStatus: () => of({ stages: [] }),
            getAssetDetailsByAddress: (address: string) =>
              new Observable<never>(() => {
                requests.push(address);
                return () => (cancelled += 1);
              }),
          },
        },
      ],
    });
    TestBed.overrideComponent(InfoEnrichmentComponent, { set: { imports: [], template: '' } });
  });

  it('keeps the in-flight request when the same photo gets a new record', () => {
    const fixture = TestBed.createComponent(InfoEnrichmentComponent);
    fixture.detectChanges();
    focusedAsset.set({ ...asset, edited: true });
    fixture.detectChanges();
    expect(requests).toEqual([asset.id]);
    expect(cancelled).toBe(0);
  });

  it('replaces the request when focus moves to another photo', () => {
    const fixture = TestBed.createComponent(InfoEnrichmentComponent);
    fixture.detectChanges();
    focusedAsset.set({ ...asset, id: 'library:other.dng' });
    fixture.detectChanges();
    expect(requests).toEqual([asset.id, 'library:other.dng']);
    expect(cancelled).toBe(1);
  });
});
