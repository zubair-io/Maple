import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { ratingValue } from './xmp-culling';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import type { XmpCulling } from './xmp.types';

const lightroomSidecar = (culling: string) => `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    ${culling}
    crs:Version="15.0"
    crs:Exposure2012="+0.50">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

describe('xmp:Rating and xmp:Label survive saves (#4403)', () => {
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  let directory: string;
  let sidecar: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'maple-authored-culling-'));
    sidecar = join(directory, 'IMG_0001.xmp');
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function saved(
    source: string,
    edit: { exposure?: number; culling?: Partial<XmpCulling> },
  ): Promise<string> {
    await fs.writeFile(sidecar, source);
    const xml = await fs.readFile(sidecar, 'utf8');
    const parsed = parser.parseAdjustmentModel(xml);
    const model = {
      ...defaultAdjustmentModel(),
      ...parsed.model,
      ...(edit.exposure === undefined ? {} : { exposure: edit.exposure }),
    };
    const culling = { ...parser.parseCulling(xml), ...edit.culling };
    await fs.writeFile(sidecar, serializer.serialize(model, parsed.passthrough, culling));
    return fs.readFile(sidecar, 'utf8');
  }

  it('keeps a Lightroom reject and red label through an unrelated exposure edit', async () => {
    const source = lightroomSidecar('xmp:Rating="-1" xmp:Label="Red"');
    const loaded = parser.parseCulling(source);
    expect(loaded.rating).toBe(0);
    expect(loaded.flag).toBe('unflagged');
    expect(loaded.colorLabel).toBe('red');

    const xml = await saved(source, { exposure: 1.25 });

    expect(xml).toContain('xmp:Rating="-1"');
    expect(xml).toContain('xmp:Label="Red"');
    expect(xml.split('xmp:Rating=')).toHaveLength(2);
    expect(xml.split('xmp:Label=')).toHaveLength(2);
    expect(xml).not.toContain('papp:Flag=');
    expect(parser.parseAdjustmentModel(xml).model.exposure).toBe(1.25);
    expect(parser.parseCulling(xml).colorLabel).toBe('red');
  });

  it('keeps an unchanged fractional rating byte-for-byte', async () => {
    const xml = await saved(lightroomSidecar('xmp:Rating="3.0"'), { exposure: 0.75 });
    expect(xml).toContain('xmp:Rating="3.0"');
    expect(parser.parseCulling(xml).rating).toBe(3);
  });

  it('rewrites the rating canonically when the user edits it', async () => {
    const xml = await saved(lightroomSidecar('xmp:Rating="-1"'), { culling: { rating: 4 } });
    expect(xml).toContain('xmp:Rating="4"');
    expect(xml).not.toContain('xmp:Rating="-1"');
  });

  it('omits a rating the user cleared', async () => {
    const xml = await saved(lightroomSidecar('xmp:Rating="3"'), { culling: { rating: 0 } });
    expect(xml).not.toContain('xmp:Rating=');
  });

  it('drops the Adobe colour word the user replaced', async () => {
    const xml = await saved(lightroomSidecar('xmp:Label="Red"'), {
      culling: { colorLabel: 'blue' },
    });
    expect(xml).not.toContain('xmp:Label=');
    expect(xml).toContain('papp:ColorLabel="blue"');
    expect(parser.parseCulling(xml).colorLabel).toBe('blue');
  });

  it('drops the Adobe colour word when the user clears the label', async () => {
    const xml = await saved(lightroomSidecar('xmp:Label="Red"'), {
      culling: { colorLabel: null },
    });
    expect(xml).not.toContain('xmp:Label=');
    expect(parser.parseCulling(xml).colorLabel).toBeNull();
  });

  it('keeps a custom label word through a colour label edit', async () => {
    const xml = await saved(lightroomSidecar('xmp:Label="To Do"'), {
      culling: { colorLabel: 'green' },
    });
    expect(xml).toContain('xmp:Label="To Do"');
    expect(xml).toContain('papp:ColorLabel="green"');
  });

  it('never reads xmp:Label as a flag', () => {
    for (const word of ['Rejected', 'reject', 'Red', 'pick']) {
      expect(parser.parseCulling(lightroomSidecar(`xmp:Label="${word}"`)).flag).toBe('unflagged');
    }
  });

  it('parses ratings the way the writer compares them', () => {
    expect(ratingValue('3.0')).toBe(3);
    expect(ratingValue('-1')).toBe(0);
    expect(ratingValue('5')).toBe(5);
    expect(ratingValue('nope')).toBe(0);
  });
});
