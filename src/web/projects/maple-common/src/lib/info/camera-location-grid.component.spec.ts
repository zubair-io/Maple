// CameraLocationGridComponent — spec.
//
// The rendering logic is a pure projection (`rowsFor`); exercise the
// projection directly + spot-check that the template renders 8 rows.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { CameraLocationGridComponent } from './camera-location-grid.component';
import type { Asset } from '../models/asset';

const STUB_ASSET: Asset = {
  id: 'a-1',
  filename: 'IMG.dng',
  folderId: 'f-1',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  camera: 'Hasselblad L3D-100c',
  lens: '24-70mm f/2.8',
  aperture: 'f/8.0',
  shutter: '1/250',
  iso: 200,
  focalLength: '35mm',
  gps: { lat: 48.85841, lon: 2.29452 },
  city: 'Paris',
};

describe('CameraLocationGridComponent.rowsFor', () => {
  it('projects all 8 spec rows from a complete asset', () => {
    const rows = CameraLocationGridComponent.rowsFor(STUB_ASSET);
    expect(rows.map((r) => r.id)).toEqual([
      'body',
      'lens',
      'aperture',
      'shutter',
      'iso',
      'focal',
      'coords',
      'city',
    ]);
    expect(rows.find((r) => r.id === 'body')?.value).toBe('Hasselblad L3D-100c');
    expect(rows.find((r) => r.id === 'iso')?.value).toBe('200');
    expect(rows.find((r) => r.id === 'coords')?.value).toBe('48.8584, 2.2945');
    expect(rows.find((r) => r.id === 'city')?.value).toBe('Paris');
  });

  it('uses em-dash fallback when fields are missing', () => {
    const minimal: Asset = {
      ...STUB_ASSET,
      camera: undefined,
      lens: undefined,
      aperture: undefined,
      shutter: undefined,
      iso: undefined,
      focalLength: undefined,
      gps: undefined,
      city: undefined,
    };
    const rows = CameraLocationGridComponent.rowsFor(minimal);
    expect(rows.every((r) => r.value === '—')).toBe(true);
  });

  it('falls back to em-dashes for a null asset (panel placeholder)', () => {
    const rows = CameraLocationGridComponent.rowsFor(null);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.value === '—')).toBe(true);
  });

  it('coords formats to 4 decimals (truncates noise)', () => {
    const a: Asset = { ...STUB_ASSET, gps: { lat: 1.123456789, lon: -2.987654321 } };
    const coords = CameraLocationGridComponent.rowsFor(a).find((r) => r.id === 'coords');
    expect(coords?.value).toBe('1.1235, -2.9877');
  });
});

describe('CameraLocationGridComponent template', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders 8 rows for a complete asset', () => {
    TestBed.configureTestingModule({ imports: [CameraLocationGridComponent] });
    const fixture = TestBed.createComponent(CameraLocationGridComponent);
    fixture.componentRef.setInput('asset', STUB_ASSET);
    fixture.detectChanges();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid^="info-row-"]',
    );
    expect(rows.length).toBe(8);
  });
});
