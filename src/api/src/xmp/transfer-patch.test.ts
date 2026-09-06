import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from '../fs/mirrored.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyTransferPatch, parseTransferPatch, type XmpTransferPatch } from './transfer-patch.ts';
import { xmlSpans, descriptions, TRANSFER_NAMESPACES as NS } from './transfer-document.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const document = (body: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:c="${NS.crs}" xmlns:papp="${NS.papp}">${body}</rdf:RDF></x:xmpmeta>`;
const patch = (
  attributes: XmpTransferPatch['attributes'],
  elements: XmpTransferPatch['elements'] = {},
) => parseTransferPatch({ attributes, elements });

async function roundTrip(xml: string, transfer: XmpTransferPatch): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'maple-transfer-'));
  dirs.push(dir);
  const file = join(dir, 'photo.xmp');
  await writeFile(file, xml);
  await writeFile(file, applyTransferPatch(await readFile(file, 'utf8'), transfer));
  return readFile(file, 'utf8');
}

describe('sparse XMP transfer against actual sidecar files', () => {
  it('changes alias-qualified selected attributes while preserving nested masks and unknown bytes', async () => {
    const masks = `<c:GradientBasedCorrections><rdf:Seq><rdf:li c:LocalHue='12.5' papp:RangeLumaMin="0.12" papp:RangeInvert="True"/></rdf:Seq></c:GradientBasedCorrections>`;
    const foreign = `<alien:Data xmlns:alien='urn:foreign' alien:foo="&#65; &amp; π">🦊</alien:Data>`;
    const xml = document(
      `<rdf:Description rdf:about="" xmlns:crs="urn:foreign" crs:Exposure2012='keep' c:Exposure2012='2' c:Contrast2012="5">\n<!-- exact -->${masks}${foreign}</rdf:Description>`,
    );
    const changed = await roundTrip(xml, patch({ 'crs:Exposure2012': '1.25' }));
    expect(changed).toContain(masks);
    expect(changed).toContain(foreign);
    expect(changed).toContain('<!-- exact -->');
    expect(changed).toContain("crs:Exposure2012='keep'");
    expect(changed).toContain('c:Contrast2012="5"');
    expect(changed).toContain('maple_crs:Exposure2012="1.25"');
    expect(applyTransferPatch(changed, patch({ 'crs:Exposure2012': '1.25' }))).toBe(changed);
  });

  it('resets a selected default across same-subject descriptions and keeps another subject untouched', async () => {
    const other = `<rdf:Description rdf:about="urn:other" c:Exposure2012="9"/>`;
    const changed = await roundTrip(
      document(
        `${other}<rdf:Description rdf:about="" c:Exposure2012="2"/><rdf:Description rdf:about="" c:Exposure2012="3"/>`,
      ),
      patch({ 'crs:Exposure2012': null }),
    );
    expect(changed).toContain(other);
    expect(changed.match(/Exposure2012/g)).toHaveLength(1);
  });

  it('copies a point curve, resets only selected curves, and is byte-idempotent', async () => {
    const curve = `<papp:SceneLinearToneCurve xmlns:papp="${NS.papp}" xmlns:rdf="${NS.rdf}"><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>1, 0.8</rdf:li></rdf:Seq></papp:SceneLinearToneCurve>`;
    const untouched =
      '<c:ToneCurvePV2012Red><rdf:Seq><rdf:li>0, 1</rdf:li></rdf:Seq></c:ToneCurvePV2012Red>';
    const original = document(`<rdf:Description rdf:about="">${untouched}</rdf:Description>`);
    const transfer = patch({}, { 'papp:SceneLinearToneCurve': curve });
    const changed = await roundTrip(original, transfer);
    expect(changed).toContain(curve);
    expect(changed).toContain(untouched);
    expect(applyTransferPatch(changed, transfer)).toBe(changed);
    const reset = applyTransferPatch(changed, patch({}, { 'papp:SceneLinearToneCurve': null }));
    expect(reset).not.toContain('SceneLinearToneCurve');
    expect(reset).toContain(untouched);
  });

  it('creates an absent sidecar and expands self-closing descriptions for curves', async () => {
    const changed = await roundTrip('', patch({ 'crs:Exposure2012': '-0.5' }));
    expect(descriptions(xmlSpans(changed))).toHaveLength(1);
    expect(changed).toContain('crs:Exposure2012="-0.5"');
    const authored = applyTransferPatch(
      document('<rdf:Description rdf:about="" c:HasSettings="False"/>'),
      patch({ 'crs:Exposure2012': '1' }),
    );
    expect(authored).toContain('crs:HasSettings="True"');
    expect(authored).not.toContain('HasSettings="False"');
    const curve = `<c:ToneCurvePV2012 xmlns:c="${NS.crs}" xmlns:rdf="${NS.rdf}"><rdf:Seq/></c:ToneCurvePV2012>`;
    const expanded = applyTransferPatch(changed, patch({}, { 'crs:ToneCurvePV2012': curve }));
    expect(expanded).toContain(curve);
    expect(applyTransferPatch(expanded, patch({}, { 'crs:ToneCurvePV2012': curve }))).toBe(
      expanded,
    );
  });

  it('refuses unsupported provenance, masks, malformed XML and mismatched curve roots', () => {
    expect(() => patch({ 'papp:WbSampleX': '0.3' })).toThrow('cannot be transferred');
    expect(() => patch({ 'crs:LocalHue': '5' })).toThrow('cannot be transferred');
    expect(() => patch({}, { 'papp:SceneLinearToneCurve': '<wrong/>' })).toThrow('does not match');
    expect(() => applyTransferPatch('<broken>', patch({ 'crs:Exposure2012': '1' }))).toThrow();
    expect(() =>
      applyTransferPatch('<!DOCTYPE x [<!ENTITY y "x">]><x/>', patch({ 'crs:Exposure2012': '1' })),
    ).toThrow('DOCTYPE');
    expect(patch({ 'papp:WbSampleX': null }).attributes).toEqual({ 'papp:WbSampleX': null });
  });
});
