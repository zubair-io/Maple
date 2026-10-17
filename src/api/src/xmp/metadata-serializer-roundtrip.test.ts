/**
 * On-disk round-trip tests for the server-side metadata merge (#4684).
 *
 * Each case writes a real `.xmp` into a temp library root, runs the merge
 * through `updateXmpAtomic` — the exact path `POST /api/xmp/batch` uses, atomic
 * writer included — reads the bytes back and parses them with `parseXmpMetadata`.
 * No mocks: the sidecar is the contract.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { mergeMetadataIntoXmp } from './metadata-serializer.ts';
import { parseXmpMetadata } from './metadata-parser.ts';
import type { XmpMetadataInput } from './metadata-input.ts';
import { updateXmpAtomic } from '../fs/xmp.ts';
import { xmlSpans } from './transfer-document.ts';

const SELF_CLOSING_CANONICAL = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Version="11.0"
      crs:ProcessVersion="11.0"
      crs:HasSettings="True"
      crs:Exposure2012="0.5"/>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const SINGLE_QUOTED_EXIFTOOL = `<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>
<x:xmpmeta xmlns:x='adobe:ns:meta/' x:xmptk='Image::ExifTool 12.76'>
 <rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>
  <rdf:Description rdf:about=''
   xmlns:xmp='http://ns.adobe.com/xap/1.0/'
   xmlns:photoshop='http://ns.adobe.com/photoshop/1.0/'
   xmp:Rating='3'
   photoshop:City='Lyon'
   photoshop:Country='France'/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end='w'?>`;

const SECOND_DESCRIPTION = `    <rdf:Description rdf:about="uuid:other"
      xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
      xmpMM:DocumentID="xmp.did:1234">
      <xmpMM:History>
        <rdf:Seq>
          <rdf:li xmpMM:action="saved"/>
        </rdf:Seq>
      </xmpMM:History>
    </rdf:Description>`;

const MULTI_DESCRIPTION = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:HasSettings="True"/>
${SECOND_DESCRIPTION}
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const TRUNCATED = SELF_CLOSING_CANONICAL.replace('</x:xmpmeta>\n', '');

let tmpDir: string;
let originalMapleRoots: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xmp-merge-roundtrip-')));
  originalMapleRoots = process.env.MAPLE_ROOTS;
  process.env.MAPLE_ROOTS = tmpDir;
});

afterEach(async () => {
  if (originalMapleRoots !== undefined) process.env.MAPLE_ROOTS = originalMapleRoots;
  else delete process.env.MAPLE_ROOTS;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedSidecar(stem: string, xml: string): Promise<string> {
  const sidecar = path.join(tmpDir, `${stem}.xmp`);
  await fs.writeFile(sidecar, xml, 'utf8');
  return sidecar;
}

function mergeThroughRoutePath(stem: string, meta: XmpMetadataInput) {
  return updateXmpAtomic(path.join(tmpDir, `${stem}.dng`), (existing) =>
    mergeMetadataIntoXmp(existing, meta),
  );
}

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('metadata merge on-disk round-trip (#4684)', () => {
  test('self-closing canonical sidecar gains rating, title and keywords and stays well-formed', async () => {
    const sidecar = await seedSidecar('canonical', SELF_CLOSING_CANONICAL);
    const result = await mergeThroughRoutePath('canonical', {
      rating: 4,
      title: 'Harbour at dusk',
      keywords: ['harbour', 'dusk'],
    });
    expect(result).toEqual({ ok: true, data: 'written' });

    const written = await fs.readFile(sidecar, 'utf8');
    expect(() => xmlSpans(written)).not.toThrow();
    expect(count(written, '</rdf:Description>')).toBe(1);
    expect(written).not.toMatch(/<rdf:Description[^>]*\/>/);
    expect(written).toContain('crs:Exposure2012="0.5"');

    const parsed = parseXmpMetadata(written);
    expect(parsed.rating).toBe(4);
    expect(parsed.title).toBe('Harbour at dusk');
    expect(parsed.keywords).toEqual(['harbour', 'dusk']);
  });

  test('single-quoted exiftool attributes are replaced, never duplicated', async () => {
    const sidecar = await seedSidecar('exiftool', SINGLE_QUOTED_EXIFTOOL);
    const result = await mergeThroughRoutePath('exiftool', { rating: 5, city: 'Paris' });
    expect(result).toEqual({ ok: true, data: 'written' });

    const written = await fs.readFile(sidecar, 'utf8');
    expect(() => xmlSpans(written)).not.toThrow();
    expect(count(written, 'xmp:Rating=')).toBe(1);
    expect(count(written, 'photoshop:City=')).toBe(1);
    expect(written).toContain("photoshop:Country='France'");

    const parsed = parseXmpMetadata(written);
    expect(parsed.rating).toBe(5);
    expect(parsed.city).toBe('Paris');
    expect(parsed.country).toBe('France');
  });

  test('multi-Description document: fields land in the primary description, siblings survive verbatim', async () => {
    const sidecar = await seedSidecar('multi', MULTI_DESCRIPTION);
    const result = await mergeThroughRoutePath('multi', {
      title: 'Two descriptions',
      keywords: ['a', 'b'],
    });
    expect(result).toEqual({ ok: true, data: 'written' });

    const written = await fs.readFile(sidecar, 'utf8');
    expect(() => xmlSpans(written)).not.toThrow();
    expect(written).toContain(SECOND_DESCRIPTION);
    expect(count(written, '</rdf:Description>')).toBe(2);
    expect(written.indexOf('<dc:title>')).toBeLessThan(written.indexOf('rdf:about="uuid:other"'));
    expect(written.indexOf('<dc:subject>')).toBeLessThan(written.indexOf('rdf:about="uuid:other"'));

    const parsed = parseXmpMetadata(written);
    expect(parsed.title).toBe('Two descriptions');
    expect(parsed.keywords).toEqual(['a', 'b']);
  });

  test('caption text that looks like an attribute is neither parsed nor stripped as one', async () => {
    const sidecar = await seedSidecar('caption', SELF_CLOSING_CANONICAL);
    const caption = 'Set papp:Hidden="true" to hide a photo';
    expect(await mergeThroughRoutePath('caption', { caption })).toEqual({
      ok: true,
      data: 'written',
    });

    const afterCaption = parseXmpMetadata(await fs.readFile(sidecar, 'utf8'));
    expect(afterCaption.caption).toBe(caption);
    expect(afterCaption.hidden).toBeUndefined();

    expect(await mergeThroughRoutePath('caption', { hidden: false })).toEqual({
      ok: true,
      data: 'written',
    });
    const written = await fs.readFile(sidecar, 'utf8');
    expect(() => xmlSpans(written)).not.toThrow();
    const parsed = parseXmpMetadata(written);
    expect(parsed.caption).toBe(caption);
    expect(parsed.hidden).toBe(false);
  });

  test('a sidecar that is not well-formed XML is rejected and left untouched on disk', async () => {
    const sidecar = await seedSidecar('broken', TRUNCATED);
    const result = await mergeThroughRoutePath('broken', { rating: 2, title: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).not.toBe('');
    expect(await fs.readFile(sidecar, 'utf8')).toBe(TRUNCATED);
    expect(await fs.readdir(tmpDir)).toEqual(['broken.xmp']);
  });
});

describe('mergeMetadataIntoXmp validation', () => {
  test('throws on malformed input instead of returning it for publication', () => {
    expect(() => mergeMetadataIntoXmp(TRUNCATED, { rating: 1 })).toThrow();
  });

  test('throws when the document has no rdf:Description to merge into', () => {
    const noDescription = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>`;
    expect(() => mergeMetadataIntoXmp(noDescription, { rating: 1 })).toThrow();
  });

  test('self-closing merge output is well-formed and closes the description exactly once', () => {
    const merged = mergeMetadataIntoXmp(SELF_CLOSING_CANONICAL, {
      rating: 3,
      title: 'T',
      caption: 'C',
      keywords: ['k'],
    });
    expect(() => xmlSpans(merged)).not.toThrow();
    expect(count(merged, '</rdf:Description>')).toBe(1);
    expect(count(merged, '<rdf:Description')).toBe(1);
    const parsed = parseXmpMetadata(merged);
    expect(parsed).toMatchObject({ rating: 3, title: 'T', caption: 'C', keywords: ['k'] });
  });

  test('attribute-only merge into a self-closing description keeps it self-closing', () => {
    const merged = mergeMetadataIntoXmp(SELF_CLOSING_CANONICAL, { rating: 3 });
    expect(() => xmlSpans(merged)).not.toThrow();
    expect(merged).toMatch(/xmp:Rating="3"\/>/);
    expect(count(merged, '</rdf:Description>')).toBe(0);
    expect(parseXmpMetadata(merged).rating).toBe(3);
  });
});
