import { describe, expect, it } from 'bun:test';
import { panoCropSidecar } from './pano-crop-sidecar.ts';
import type { PanoEdgesReport } from './pano-edges.ts';

function report(
  output: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number } | null,
): PanoEdgesReport {
  return {
    output,
    uncovered_px: 0,
    boundary_warp: {
      requested: 0,
      applied: 0,
      status: 'off',
      max_stretch: null,
      min_jacobian: null,
      predicted_coverage: null,
      solve_ms: null,
    },
    auto_crop: { requested: true, rect, invalid_px: rect ? 0 : null },
  };
}

const attribute = (xml: string, name: string) => xml.match(new RegExp(`${name}="([^"]*)"`))?.[1];

describe('panoCropSidecar', () => {
  it('turns the rectangle into normalized crop edges at six decimals', () => {
    const xml = panoCropSidecar(
      report({ width: 1000, height: 400 }, { x: 100, y: 40, width: 800, height: 320 }),
    )!;
    expect(attribute(xml, 'crs:HasCrop')).toBe('True');
    expect(attribute(xml, 'crs:CropLeft')).toBe('0.100000');
    expect(attribute(xml, 'crs:CropTop')).toBe('0.100000');
    expect(attribute(xml, 'crs:CropRight')).toBe('0.900000');
    expect(attribute(xml, 'crs:CropBottom')).toBe('0.900000');
    expect(attribute(xml, 'crs:CropConstrainToWarp')).toBe('0');
    expect(attribute(xml, 'crs:HasSettings')).toBe('True');
  });

  it('keeps a 360 degree panorama whole along its wrapping axis', () => {
    const xml = panoCropSidecar(
      report({ width: 4096, height: 1024 }, { x: 0, y: 64, width: 4096, height: 900 }),
    )!;
    expect(attribute(xml, 'crs:CropLeft')).toBe('0.000000');
    expect(attribute(xml, 'crs:CropRight')).toBe('1.000000');
  });

  it('records nothing when there is no rectangle or it is the whole image', () => {
    expect(panoCropSidecar(report({ width: 100, height: 50 }, null))).toBeNull();
    expect(
      panoCropSidecar(report({ width: 100, height: 50 }, { x: 0, y: 0, width: 100, height: 50 })),
    ).toBeNull();
  });

  it('records nothing for a rectangle outside the written image, as an engine that still trimmed reports', () => {
    expect(
      panoCropSidecar(
        report({ width: 800, height: 320 }, { x: 100, y: 40, width: 800, height: 320 }),
      ),
    ).toBeNull();
  });
});
