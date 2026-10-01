import '@angular/compiler';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const parser = new XmpParserService();
const writer = new XmpSerializerService();
const saveSidecar = (...args: Parameters<XmpSerializerService['serialize']>): string => {
  const directory = mkdtempSync(join(tmpdir(), 'maple-mask-group-'));
  try {
    const path = join(directory, 'photo.xmp');
    writeFileSync(path, writer.serialize(...args), 'utf8');
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const fixture = (operation: string): string =>
  readFileSync(
    resolve('../../test-fixtures/local-adjustments', `lightroom-group-${operation}.xmp`),
    'utf8',
  );

describe('ordered mask-group sidecars (#3408)', () => {
  for (const operation of ['add', 'subtract', 'intersect'] as const) {
    it(`reads and saves the real Lightroom ${operation} export`, () => {
      const parsed = parser.parseAdjustmentModel(fixture(operation));
      const model = { ...defaultAdjustmentModel(), ...parsed.model };
      expect(model.localAdjustments).toHaveLength(1);
      const mask = model.localAdjustments[0].mask;
      if (mask.kind !== 'group') throw new Error('group missing');
      expect(mask.components).toHaveLength(2);
      expect(mask.components[1].combine).toBe(operation);
      expect(mask.components[1].invert).toBe(false);
      const radial = mask.components[0].mask;
      if (radial.kind !== 'radial') throw new Error('radial missing');
      expect(radial.feather).toBe(0.5);
      expect(radial.invert).toBe(false);
      const saved = saveSidecar(model, parsed.passthrough);
      const again = parser.parseAdjustmentModel(saved).model.localAdjustments!;
      expect(again).toEqual(model.localAdjustments);
      expect((saved.match(/<crs:MaskGroupBasedCorrections/g) ?? []).length).toBe(1);
      expect(saved).toContain('papp:MaskGroupVersion="1"');
      expect(saved).toContain('crs:CorrectionName="Composition reference"');
      expect(saved).toContain('crs:MaskName="Radial reference"');
      expect(saved).toContain('crs:MaskSyncID="34080000000000000000000000000002"');
    });
  }

  it('keeps unsupported components, versions, and malformed blend data opaque', () => {
    for (const source of [
      fixture('subtract').replace('crs:MaskBlendMode="1"', 'crs:MaskBlendMode="9"'),
      fixture('subtract').replace('crs:MaskBlendMode="1"', 'crs:MaskBlendMode="NaN"'),
      fixture('subtract').replace('crs:Version="2"', 'crs:Version="3"'),
      fixture('subtract').replace('crs:Midpoint="50"', 'crs:Midpoint="25"'),
      fixture('subtract').replace('crs:Roundness="0"', 'crs:Roundness="20"'),
      fixture('subtract').replace('crs:MaskInverted="false"', 'crs:MaskInverted="unknown"'),
      fixture('subtract').replace('crs:Flipped="true"', 'crs:Flipped="unknown"'),
      fixture('subtract').replace('crs:MaskActive="true"', 'crs:MaskActive="unknown"'),
      fixture('subtract').replace('crs:CorrectionActive="true"', 'crs:CorrectionActive="unknown"'),
      fixture('subtract').replace('crs:What="Mask/Gradient"', 'crs:What="Mask/Unknown"'),
      fixture('subtract').replace(
        'crs:CorrectionActive="true"',
        'crs:CorrectionActive="true" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:RangeKind="Future"',
      ),
      fixture('subtract').replace(
        'crs:CorrectionActive="true"',
        'crs:CorrectionActive="true" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:RangeKind="Color" papp:RangeHue="NaN"',
      ),
    ]) {
      const parsed = parser.parseAdjustmentModel(source);
      expect(parsed.model.localAdjustments ?? []).toEqual([]);
      const saved = saveSidecar(
        { ...defaultAdjustmentModel(), ...parsed.model, exposure: 0.4 },
        parsed.passthrough,
      );
      const original = new DOMParser()
        .parseFromString(source, 'text/xml')
        .getElementsByTagName('crs:MaskGroupBasedCorrections')[0];
      const result = new DOMParser()
        .parseFromString(saved, 'text/xml')
        .getElementsByTagName('crs:MaskGroupBasedCorrections')[0];
      expect(result.textContent).toBe(original.textContent);
      expect(result.getElementsByTagName('rdf:li')[2].outerHTML).toBe(
        original.getElementsByTagName('rdf:li')[2].outerHTML,
      );
      expect(parser.parseAdjustmentModel(saved).model.localAdjustments ?? []).toEqual([]);
    }
  });

  it('allocates foreign metadata prefixes without shadowing an imported alias', () => {
    const original = new DOMParser().parseFromString(fixture('subtract'), 'text/xml');
    const leaf = original.getElementsByTagName('rdf:li')[1];
    leaf.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:papp', 'urn:foreign');
    leaf.setAttributeNS('urn:foreign', 'papp:Tag', 'foreign');
    const index = Array.from(leaf.attributes).findIndex(
      (attribute) => attribute.name === 'papp:Tag',
    );
    leaf.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:maskmeta${index}`, 'urn:occupied');
    leaf.setAttributeNS('urn:occupied', `maskmeta${index}:Other`, 'occupied');
    const source = new XMLSerializer().serializeToString(original);
    const parsed = parser.parseAdjustmentModel(source);
    const model = { ...defaultAdjustmentModel(), ...parsed.model };
    expect(model.localAdjustments).toHaveLength(1);
    const saved = saveSidecar(model, parsed.passthrough);
    const document = new DOMParser().parseFromString(saved, 'text/xml');
    expect(document.getElementsByTagName('parsererror')).toHaveLength(0);
    const result = document.getElementsByTagName('rdf:li')[1];
    expect(result.getAttributeNS('urn:foreign', 'Tag')).toBe('foreign');
    expect(result.getAttributeNS('urn:occupied', 'Other')).toBe('occupied');
    expect(parser.parseAdjustmentModel(saved).model.localAdjustments).toEqual(
      model.localAdjustments,
    );
  });

  it('persists opacity and inversion independently of the correction values', () => {
    const parsed = parser.parseAdjustmentModel(fixture('subtract'));
    const model = { ...defaultAdjustmentModel(), ...parsed.model };
    const mask = model.localAdjustments[0].mask;
    if (mask.kind !== 'group') throw new Error('group missing');
    model.localAdjustments[0] = {
      ...model.localAdjustments[0],
      mask: {
        ...mask,
        opacity: 0.31876543,
        invert: true,
        components: mask.components.map((component) => ({ ...component, invert: true })),
      },
    };
    const saved = saveSidecar(model, parsed.passthrough);
    expect(parser.parseAdjustmentModel(saved).model.localAdjustments).toEqual(
      model.localAdjustments,
    );
  });

  it('preserves foreign attributes and XML with their owning component through edits and deletion', () => {
    const source = fixture('subtract')
      .replace(
        'crs:CorrectionName="Composition reference"',
        'crs:CorrectionName="Composition reference" xmlns:vendor="urn:mask-vendor" vendor:Note="a &amp; b"',
      )
      .replace(
        'crs:MaskName="Radial reference"',
        'crs:MaskName="Radial reference" vendor:Tag="radial"',
      )
      .replace('crs:Version="2"/>', 'crs:Version="2"><vendor:Hint value="keep"/></rdf:li>');
    const parsed = parser.parseAdjustmentModel(source);
    const model = { ...defaultAdjustmentModel(), ...parsed.model };
    const mask = model.localAdjustments[0].mask;
    if (mask.kind !== 'group') throw new Error('group missing');
    model.localAdjustments[0] = {
      ...model.localAdjustments[0],
      adjustments: { exposure: 0.7 },
      mask: { ...mask, components: [{ ...mask.components[0], invert: true }] },
    };
    const saved = saveSidecar(model, parsed.passthrough);
    expect(saved).toContain('vendor:Note="a &amp; b"');
    expect(saved).toContain('vendor:Tag="radial"');
    expect(saved).toContain('<vendor:Hint value="keep" xmlns:vendor="urn:mask-vendor"/>');
    expect(saved).not.toContain('Linear Gradient 1');
    expect(parser.parseAdjustmentModel(saved).model.localAdjustments).toEqual(
      model.localAdjustments,
    );
  });
});
