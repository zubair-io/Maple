/**
 * Partial sidecar writes keep a repair list's frame (#4473): real `.xmp` files
 * in a temp library root, merged through `updateXmpAtomic` (the batch route's
 * writer) or `applyTransferPatch`, then read back from disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from '../fs/mirrored.ts';
import * as path from 'node:path';
import * as os from 'node:os';
import { updateXmpAtomic } from '../fs/xmp.ts';
import { mergeMetadataIntoXmp } from './metadata-serializer.ts';
import type { XmpMetadataInput } from './metadata-input.ts';
import { applyTransferPatch, parseTransferPatch } from './transfer-patch.ts';
import { xmlSpans } from './transfer-document.ts';

const PAPP = 'http://ns.justmaple.app/photo/1.0/';
const STAMP = 'papp:RetouchFrameVersion="2"';
const REPAIRS = `      <crs:RetouchAreas>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:SpotType="heal" crs:SourceState="sourceSetExplicitly" crs:Method="circle" crs:SourceX="0.750000" crs:SourceY="0.500000" crs:Opacity="1.000000" crs:Feather="0.500000" crs:Seed="0">
              <crs:Masks>
                <rdf:Seq>
                  <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1" crs:X="0.250000" crs:Y="0.400000" crs:Radius="0.050000" crs:Flow="1" crs:CenterWeight="0"/>
                </rdf:Seq>
              </crs:Masks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:RetouchAreas>`;
const LEGACY_STRINGS = `      <crs:RetouchInfo>
        <rdf:Seq>
          <rdf:li>centerX = 0.250000, centerY = 0.400000, radius = 0.050000, sourceState = sourceSetExplicitly, sourceX = 0.750000, sourceY = 0.500000, spotType = heal</rdf:li>
        </rdf:Seq>
      </crs:RetouchInfo>`;
const WORKFLOW = `      <papp:Workflow xmlns:papp="${PAPP}" papp:Record="{}"/>`;

const sidecar = (
  descriptionAttributes: string,
  children: string,
) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"${descriptionAttributes}
      crs:Version="11.0">
${children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
`;
const LIGHTROOM = sidecar('', REPAIRS);
const LEGACY_MAPLE = sidecar(`\n      xmlns:papp="${PAPP}"\n      papp:Profile="Auto"`, REPAIRS);

let root: string;
let previousRoots: string | undefined;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retouch-frame-')));
  previousRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = root;
});

afterEach(async () => {
  if (previousRoots !== undefined) process.env.MAPLE_ROOTS = previousRoots;
  else delete process.env.MAPLE_ROOTS;
  await fs.rm(root, { recursive: true, force: true });
});

async function mergeOnDisk(source: string, edits: XmpMetadataInput[]): Promise<string> {
  const file = path.join(root, 'photo.xmp');
  await fs.writeFile(file, source, 'utf8');
  for (const meta of edits) {
    const result = await updateXmpAtomic(path.join(root, 'photo.dng'), (existing) =>
      mergeMetadataIntoXmp(existing, meta),
    );
    expect(result.ok).toBe(true);
  }
  return fs.readFile(file, 'utf8');
}

async function patchOnDisk(source: string, attributes: Record<string, string>): Promise<string> {
  const file = path.join(root, 'photo.xmp');
  await fs.writeFile(file, source, 'utf8');
  const patch = parseTransferPatch({ attributes, elements: {} });
  await fs.writeFile(file, applyTransferPatch(await fs.readFile(file, 'utf8'), patch));
  return fs.readFile(file, 'utf8');
}

const stamps = (xml: string) => xml.split('papp:RetouchFrameVersion').length - 1;

describe('repair-list frame through partial sidecar writes (#4473)', () => {
  test('a flag on a Lightroom sidecar stamps the retained list once, across repeated saves', async () => {
    const written = await mergeOnDisk(LIGHTROOM, [{ flag: 'pick' }, { colorLabel: 'red' }]);
    expect(() => xmlSpans(written)).not.toThrow();
    expect(written).toContain(STAMP);
    expect(stamps(written)).toBe(1);
    expect(written).toContain(REPAIRS);
  });

  test('a legacy Lightroom string list is stamped by a metadata save and a pasted setting', async () => {
    const strings = sidecar('', LEGACY_STRINGS);
    const flagged = await mergeOnDisk(strings, [{ flag: 'pick' }]);
    expect(stamps(flagged)).toBe(1);
    expect(flagged).toContain(LEGACY_STRINGS);
    expect(stamps(await patchOnDisk(strings, { 'papp:Profile': 'Neutral' }))).toBe(1);
    const legacyMaple = sidecar(
      `\n      xmlns:papp="${PAPP}"\n      papp:Profile="Auto"`,
      LEGACY_STRINGS,
    );
    expect(stamps(await mergeOnDisk(legacyMaple, [{ flag: 'pick' }]))).toBe(0);
  });

  test('a legacy Maple list stays unstamped through a metadata save', async () => {
    const written = await mergeOnDisk(LEGACY_MAPLE, [{ flag: 'reject' }]);
    expect(stamps(written)).toBe(0);
    expect(written).toContain(REPAIRS);
  });

  test('an edit that adds no Maple markup leaves a Lightroom sidecar unstamped', async () => {
    const written = await mergeOnDisk(LIGHTROOM, [{ title: 'Harbour' }]);
    expect(written).not.toContain('xmlns:papp');
    expect(stamps(written)).toBe(0);
  });

  test('a Lightroom sidecar without repairs gains no stamp', async () => {
    const written = await mergeOnDisk(sidecar('', ''), [{ flag: 'pick' }]);
    expect(stamps(written)).toBe(0);
  });

  test('an embedded workflow record does not make a Lightroom list legacy', async () => {
    const withWorkflow = sidecar('', `${WORKFLOW}\n${REPAIRS}`);
    expect(stamps(await patchOnDisk(withWorkflow, { 'papp:Profile': 'Neutral' }))).toBe(1);
  });

  test('a pasted Maple setting stamps a Lightroom list and leaves a legacy list alone', async () => {
    expect(stamps(await patchOnDisk(LIGHTROOM, { 'papp:Profile': 'Neutral' }))).toBe(1);
    expect(stamps(await patchOnDisk(LEGACY_MAPLE, { 'papp:Profile': 'Neutral' }))).toBe(0);
    expect(stamps(await patchOnDisk(LIGHTROOM, { 'crs:Exposure2012': '0.5' }))).toBe(0);
  });
});
