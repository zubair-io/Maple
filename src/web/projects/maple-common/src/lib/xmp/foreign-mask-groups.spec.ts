import '@angular/compiler';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAdjustmentModel, type LocalAdjustment } from '../models/adjustment-model';
import { CRS_NAMESPACE, RDF_NAMESPACE } from './xmp-dom-utils';
import { localCorrectionBlock } from './xmp-local-adjustments';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';

const parser = new XmpParserService();
const writer = new XmpSerializerService();
const everywhere: LocalAdjustment = {
  mask: { kind: 'everywhere' },
  adjustments: { exposure: 0.3 },
};
const bitmap: LocalAdjustment = {
  mask: {
    kind: 'bitmap',
    rasterId: 0,
    recipe: {
      person: 0,
      facialSkin: true,
      bodySkin: true,
      model: 'test/1',
      digest: '0123456789abcdef',
    },
  },
  adjustments: { hue: 12 },
};
const foreign = `<rdf:li><rdf:Description crs:What="Correction" crs:CorrectionAmount="0.4"
  crs:CorrectionActive="True" crs:LocalExposure2012="1" crs:LocalClarity2012="27" crs:CorrectionName="Subject &amp; sky">
  <!-- preserve this composite recipe and its source order -->
  <crs:CorrectionMasks><rdf:Seq>
    <rdf:li crs:What="Mask/Image" crs:MaskDigest="lightroom-ai" crs:MaskSubType="0"/>
    <rdf:li crs:What="Mask/Range" crs:MaskValue="0"><foreign:Payload><![CDATA[opaque <bytes>]]></foreign:Payload></rdf:li>
  </rdf:Seq></crs:CorrectionMasks>
</rdf:Description></rdf:li>`;
const group = (items: string): string =>
  `<crs:MaskGroupBasedCorrections foreign:Version="7"><rdf:Seq>${items}</rdf:Seq></crs:MaskGroupBasedCorrections>`;
const sidecar = (children: string, secondary = ''): string => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="${RDF_NAMESPACE}" xmlns:crs="${CRS_NAMESPACE}"
 xmlns:papp="http://ns.justmaple.app/photo/1.0/" xmlns:foreign="urn:foreign-mask">
<rdf:Description rdf:about="" crs:Exposure2012="0.5" crs:Contrast2012="2">${children}</rdf:Description>
${secondary}</rdf:RDF></x:xmpmeta>`;
const save = (xml: string, layers?: LocalAdjustment[]): string => {
  const { model, passthrough } = parser.parseAdjustmentModel(xml);
  return writer.serialize(
    { ...defaultAdjustmentModel(), ...model, ...(layers ? { localAdjustments: layers } : {}) },
    passthrough,
  );
};
const groupElements = (xml: string): Element[] =>
  Array.from(
    new DOMParser()
      .parseFromString(xml, 'text/xml')
      .getElementsByTagNameNS(CRS_NAMESPACE, 'MaskGroupBasedCorrections'),
  );
const opaqueCorrection = (xml: string): string => {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const description = Array.from(doc.getElementsByTagNameNS(RDF_NAMESPACE, 'Description')).find(
    (element) => element.getAttributeNS(CRS_NAMESPACE, 'CorrectionName') === 'Subject & sky',
  );
  expect(description).toBeDefined();
  return description!.parentElement!.outerHTML;
};

describe('foreign AI mask group preservation (#3423)', () => {
  it('keeps an opaque Lightroom group through an on-disk develop edit and repeated saves', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maple-foreign-ai-'));
    const path = join(directory, 'photo.xmp');
    try {
      writeFileSync(path, sidecar(group(foreign)));
      const source = readFileSync(path, 'utf8');
      const { model, passthrough } = parser.parseAdjustmentModel(source);
      expect(model.localAdjustments).toEqual([]);
      writeFileSync(
        path,
        writer.serialize({ ...defaultAdjustmentModel(), ...model, exposure: 1.25 }, passthrough),
      );
      const edited = readFileSync(path, 'utf8');
      expect(opaqueCorrection(edited)).toBe(opaqueCorrection(source));
      expect(edited).toContain('foreign:Version="7"');
      expect(parser.parseAdjustmentModel(edited).model.exposure).toBe(1.25);
      writeFileSync(path, save(edited));
      expect(readFileSync(path, 'utf8')).toBe(edited);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('edits Maple bitmap/everywhere slots without duplicating or reordering foreign corrections', () => {
    const source = sidecar(
      group(localCorrectionBlock(bitmap, '') + foreign + localCorrectionBlock(everywhere, '')),
    );
    const loaded = parser.parseAdjustmentModel(source).model.localAdjustments!;
    expect(loaded).toEqual([
      { ...bitmap, xmpGroupSlot: 0 },
      { ...everywhere, xmpGroupSlot: 1 },
    ]);
    const editedBitmap = { ...loaded[0], adjustments: { hue: -25 } };
    const edited = save(source, [editedBitmap, loaded[1]]);
    expect(groupElements(edited)).toHaveLength(1);
    expect(opaqueCorrection(edited)).toBe(opaqueCorrection(source));
    const masks = [...groupElements(edited)[0].getElementsByTagNameNS(RDF_NAMESPACE, 'li')];
    expect(
      masks.filter((item) =>
        item.getAttributeNS('http://ns.justmaple.app/photo/1.0/', 'MaskSource'),
      ),
    ).toHaveLength(2);
    expect(edited.indexOf('papp:MaskSource="PersonSkin"')).toBeLessThan(
      edited.indexOf('crs:CorrectionName="Subject'),
    );
    expect(edited.indexOf('crs:CorrectionName="Subject')).toBeLessThan(
      edited.indexOf('papp:MaskSource="Everywhere"'),
    );
    expect(parser.parseAdjustmentModel(edited).model.localAdjustments).toEqual([
      editedBitmap,
      loaded[1],
    ]);
    expect(save(edited)).toBe(edited);
    expect(edited).not.toContain('xmpGroupSlot');
    const removedFirst = save(edited, [loaded[1]]);
    expect(removedFirst.indexOf('crs:CorrectionName="Subject')).toBeLessThan(
      removedFirst.indexOf('papp:MaskSource="Everywhere"'),
    );
    expect(parser.parseAdjustmentModel(removedFirst).model.localAdjustments).toEqual([
      { ...everywhere, xmpGroupSlot: 0 },
    ]);
    expect(save(removedFirst)).toBe(removedFirst);
    const deleted = save(edited, []);
    expect(parser.parseAdjustmentModel(deleted).model.localAdjustments).toEqual([]);
    expect(opaqueCorrection(deleted)).toBe(opaqueCorrection(source));
    expect(save(deleted)).toBe(deleted);
  });

  it('appends a newly created Maple layer into the existing foreign group', () => {
    const first = save(sidecar(group(foreign)), [everywhere]);
    expect(groupElements(first)).toHaveLength(1);
    expect(parser.parseAdjustmentModel(first).model.localAdjustments).toEqual([
      { ...everywhere, xmpGroupSlot: 0 },
    ]);
    expect(save(first)).toBe(first);
  });

  it('preserves aliased namespaces and secondary RDF groups without an old duplicate', () => {
    const aliased = group(foreign + localCorrectionBlock(bitmap, ''))
      .replaceAll('crs:', 'camera:')
      .replaceAll('rdf:', 'r:');
    const source = sidecar(
      '',
      `<rdf:Description rdf:about="" xmlns:r="${RDF_NAMESPACE}" xmlns:camera="${CRS_NAMESPACE}">${aliased}</rdf:Description>`,
    );
    const first = save(source);
    expect(groupElements(first)).toHaveLength(1);
    expect(parser.parseAdjustmentModel(first).model.localAdjustments).toEqual([
      { ...bitmap, xmpGroupSlot: 0 },
    ]);
    expect(first).toContain('camera:MaskDigest="lightroom-ai"');
    expect(save(first)).toBe(first);
  });

  it('leaves a nested RDF subtree in ordinary passthrough without collecting a duplicate', () => {
    const nested = `<foreign:Nested><rdf:RDF><rdf:Description>${group(foreign)}</rdf:Description></rdf:RDF></foreign:Nested>`;
    const source = sidecar(nested);
    expect(parser.parseAdjustmentModel(source).model.localAdjustments).toBeUndefined();
    const first = save(source);
    expect(groupElements(first)).toHaveLength(1);
    expect(parser.parseAdjustmentModel(first).passthrough.maskGroups).toBeUndefined();
    expect(save(first)).toBe(first);
  });

  it('keeps authored comments resembling template markers', () => {
    const correction = foreign
      .replace('opaque <bytes>', 'maple-mask-slot0')
      .replace('<!-- preserve', '<!--maple-mask-slotappend--><!-- preserve');
    const source = sidecar(group(correction));
    const first = save(source, [everywhere]);
    expect(first).toContain('<!--maple-mask-slotappend-->');
    expect(first).toContain('<![CDATA[maple-mask-slot0]]>');
    expect(parser.parseAdjustmentModel(first).model.localAdjustments).toEqual([
      { ...everywhere, xmpGroupSlot: 0 },
    ]);
    expect(save(first)).toBe(first);
  });

  it('retains foreign wrapper attributes and sibling nodes around a modeled Maple mask', () => {
    const source = sidecar(
      group(localCorrectionBlock(everywhere, '')).replace(
        '</crs:MaskGroupBasedCorrections>',
        '<foreign:Recipe>opaque</foreign:Recipe></crs:MaskGroupBasedCorrections>',
      ),
    );
    const first = save(source);
    expect(first).toContain('foreign:Version="7"');
    expect(first).toContain('<foreign:Recipe>opaque</foreign:Recipe>');
    expect(parser.parseAdjustmentModel(first).model.localAdjustments).toEqual([
      { ...everywhere, xmpGroupSlot: 0 },
    ]);
    expect(save(first)).toBe(first);
  });

  it.each(['rdf:about="other-photo"', 'xml:lang="fr"', 'xml:base="other/"'])(
    'preserves a secondary group in its distinct %s context',
    (context) => {
      const source = sidecar('', `<rdf:Description ${context}>${group(foreign)}</rdf:Description>`);
      const first = save(source);
      expect(parser.parseAdjustmentModel(first).passthrough.maskGroups).toBeUndefined();
      expect(groupElements(first)).toHaveLength(1);
      const [name, value] = context.split('=');
      expect(groupElements(first)[0].parentElement!.getAttribute(name)).toBe(value.slice(1, -1));
      expect(save(first)).toBe(first);
    },
  );

  it.each([
    [
      'inactive Maple mask',
      localCorrectionBlock(bitmap, '').replace(
        'CorrectionActive="True"',
        'CorrectionActive="False"',
      ),
    ],
    [
      'incomplete Maple recipe',
      localCorrectionBlock(bitmap, '').replace('papp:MaskDigest="0123456789abcdef"', ''),
    ],
    [
      'mixed foreign and Maple leaves',
      localCorrectionBlock(everywhere, '').replace(
        '</rdf:Seq>',
        '<rdf:li crs:What="Mask/Image" crs:MaskDigest="foreign"/></rdf:Seq>',
      ),
    ],
  ])('keeps an unmodeled %s opaque instead of approximating or discarding it', (_, correction) => {
    const source = sidecar(group(correction));
    expect(parser.parseAdjustmentModel(source).model.localAdjustments).toEqual([]);
    const first = save(source);
    expect(groupElements(first)[0].children[0].children[0].outerHTML).toBe(
      groupElements(source)[0].children[0].children[0].outerHTML,
    );
    expect(save(first)).toBe(first);
  });
});
