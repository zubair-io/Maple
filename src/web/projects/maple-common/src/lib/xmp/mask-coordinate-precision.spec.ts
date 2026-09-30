import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';

describe('mask coordinate precision', () => {
  it('preserves fine coordinates over repeated round trips', () => {
    TestBed.configureTestingModule({});
    const parser = TestBed.inject(XmpParserService);
    const serializer = TestBed.inject(XmpSerializerService);
    const model = defaultAdjustmentModel();
    model.localAdjustments = [
      {
        mask: {
          kind: 'linear',
          start: { x: 0.300698, y: 0.500123 },
          end: { x: 0.700321, y: 0.499876 },
          feather: 0.5,
        },
        adjustments: {},
      },
      {
        mask: {
          kind: 'radial',
          center: { x: 0.500698, y: 0.499876 },
          radii: { x: 0.001234, y: 0.002345 },
          angle: 0,
          feather: 0.5,
          invert: false,
        },
        adjustments: {},
      },
    ];
    const xml = serializer.serialize(model);
    expect(xml).toContain('crs:ZeroX="0.300698" crs:ZeroY="0.500123"');
    expect(xml).toContain(
      'crs:Top="0.497531" crs:Left="0.499464" crs:Bottom="0.502221" crs:Right="0.501932"',
    );
    let current = xml;
    for (let i = 0; i < 5; i++) {
      const parsed = parser.parseAdjustmentModel(current);
      expect(parsed.model.localAdjustments).toHaveLength(2);
      current = serializer.serialize(
        { ...defaultAdjustmentModel(), ...parsed.model },
        parsed.passthrough,
      );
      expect(current).toBe(xml);
    }
  });
});
