import '@angular/compiler';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { RDF_NAMESPACE } from './xmp-dom-utils';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const EXIF = 'http://ns.adobe.com/exif/1.0/';
const DC = 'http://purl.org/dc/elements/1.1/';

const parser = new XmpParserService();
const writer = new XmpSerializerService();

const saveSidecar = (xml: string): string => {
  const { model, passthrough } = parser.parseAdjustmentModel(xml);
  const directory = mkdtempSync(join(tmpdir(), 'maple-mask-metadata-'));
  try {
    const path = join(directory, 'photo.xmp');
    writeFileSync(
      path,
      writer.serialize({ ...defaultAdjustmentModel(), ...model }, passthrough),
      'utf8',
    );
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const source = readFileSync(
  resolve('../../test-fixtures/local-adjustments', 'lightroom-group-subtract.xmp'),
  'utf8',
)
  .replace(
    'crs:CorrectionName="Composition reference"',
    `crs:CorrectionName="Composition reference" xmlns:exif="${EXIF}" xmlns:dc="${DC}" exif:UserComment="Night &amp; day" dc:source="archive"`,
  )
  .replace(
    'crs:MaskName="Radial reference"',
    'crs:MaskName="Radial reference" exif:ImageUniqueID="abc123" dc:identifier="leaf-1"',
  );

const parseXml = (xml: string): Document => new DOMParser().parseFromString(xml, 'text/xml');

const correctionAndLeaf = (document: Document): [Element, Element] => {
  const description = Array.from(
    document.getElementsByTagNameNS(RDF_NAMESPACE, 'Description'),
  ).find((element) => element.getAttributeNS(EXIF, 'UserComment') !== null);
  if (!description) throw new Error('correction carrying exif:UserComment missing');
  const leaf = Array.from(description.getElementsByTagNameNS(RDF_NAMESPACE, 'li')).find(
    (element) => element.getAttributeNS(EXIF, 'ImageUniqueID') !== null,
  );
  if (!leaf) throw new Error('mask leaf carrying exif:ImageUniqueID missing');
  return [description, leaf];
};

describe('recognised metadata namespaces on mask-group corrections (#4689)', () => {
  it('declares exif and dc bindings for correction- and leaf-level metadata', () => {
    expect(parser.parseAdjustmentModel(source).model.localAdjustments).toHaveLength(1);
    const saved = saveSidecar(source);
    const document = parseXml(saved);
    expect(document.getElementsByTagName('parsererror')).toHaveLength(0);
    const [correction, leaf] = correctionAndLeaf(document);
    expect(correction.getAttributeNS(EXIF, 'UserComment')).toBe('Night & day');
    expect(correction.getAttributeNS(DC, 'source')).toBe('archive');
    expect(leaf.getAttributeNS(EXIF, 'ImageUniqueID')).toBe('abc123');
    expect(leaf.getAttributeNS(DC, 'identifier')).toBe('leaf-1');
    expect(saved).toContain('exif:UserComment="Night &amp; day"');
    expect(saved).toContain('exif:ImageUniqueID="abc123"');
  });

  it('re-saves the declared bindings as a fixed point', () => {
    const first = saveSidecar(source);
    const second = saveSidecar(first);
    expect(second).toBe(first);
    expect(parser.parseAdjustmentModel(second).model.localAdjustments).toEqual(
      parser.parseAdjustmentModel(source).model.localAdjustments,
    );
  });
});
