import { describe, expect, it } from 'bun:test';
import { cropRegion, parseSidecarCrop } from './sidecar-crop.ts';
import { panoCropSidecar } from '../pano/pano-crop-sidecar.ts';

const document = (attributes: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${attributes}/></rdf:RDF></x:xmpmeta>`;

const CROP = 'crs:CropLeft="0.1" crs:CropTop="0.2" crs:CropRight="0.9" crs:CropBottom="0.8"';

describe('parseSidecarCrop', () => {
  it('reads the crop an Auto Crop sidecar records', () => {
    const xml = panoCropSidecar({
      output: { width: 1000, height: 400 },
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
      auto_crop: {
        requested: true,
        rect: { x: 100, y: 40, width: 800, height: 320 },
        invalid_px: 0,
      },
    })!;
    expect(parseSidecarCrop(xml)).toEqual({ left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 });
  });

  it('ignores edges unless HasCrop is True', () => {
    expect(parseSidecarCrop(document(`crs:HasCrop="False" ${CROP}`))).toBeNull();
    expect(parseSidecarCrop(document(CROP))).toBeNull();
  });

  it('applies no crop that is the whole frame, inverted, or rotated', () => {
    const edges = (l: number, t: number, r: number, b: number, extra = '') =>
      document(
        `crs:HasCrop="True" crs:CropLeft="${l}" crs:CropTop="${t}" crs:CropRight="${r}" crs:CropBottom="${b}" ${extra}`,
      );
    expect(parseSidecarCrop(edges(0, 0, 1, 1))).toBeNull();
    expect(parseSidecarCrop(edges(0.6, 0, 0.5, 1))).toBeNull();
    expect(parseSidecarCrop(edges(0.1, 0.1, 0.9, 0.9, 'crs:CropAngle="2.5"'))).toBeNull();
  });
});

describe('cropRegion', () => {
  it('maps the edges to a pixel region inside the image', () => {
    expect(cropRegion({ left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 }, 1000, 500)).toEqual({
      left: 100,
      top: 100,
      width: 800,
      height: 300,
    });
  });
});
