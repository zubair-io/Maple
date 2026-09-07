import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { XmpParserService } from './xmp-parser.service';
import { XmpSerializerService } from './xmp-serializer.service';
import type { XmpMetadata } from './xmp.types';

const DC = 'http://purl.org/dc/elements/1.1/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PHOTOSHOP = 'http://ns.adobe.com/photoshop/1.0/';
const EXIF = 'http://ns.adobe.com/exif/1.0/';
const source = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="${RDF}">
    <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:d="${DC}" xmlns:info="${PHOTOSHOP}" xmlns:vendor="https://vendor.test/"
      crs:Exposure2012="1" info:City="Paris" vendor:Keep="untouched">
      <d:title><rdf:Alt><rdf:li xml:lang="x-default">Original title</rdf:li><rdf:li xml:lang="fr">Titre original</rdf:li></rdf:Alt></d:title>
      <vendor:title>Foreign title</vendor:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="${DC}" xmlns:capture="${EXIF}"
      capture:DateTimeOriginal="2025-06-01T12:00:00+02:00">
      <dc:creator><rdf:Seq><rdf:li>First author</rdf:li><rdf:li>Second author</rdf:li></rdf:Seq></dc:creator>
      <vendor:Keep xmlns:vendor="https://vendor.test/">Foreign sibling</vendor:Keep>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;

describe('metadata survives ordinary sidecar edits', () => {
  const parser = new XmpParserService();
  const serializer = new XmpSerializerService();
  let directory: string;
  let sidecar: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'maple-metadata-preservation-'));
    sidecar = join(directory, 'photo.xmp');
    await fs.writeFile(sidecar, source);
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function edit(metadata?: XmpMetadata): Promise<Document> {
    const xml = await fs.readFile(sidecar, 'utf8');
    const parsed = parser.parseAdjustmentModel(xml);
    const model = { ...defaultAdjustmentModel(), ...parsed.model, exposure: 2 };
    // Ordinary folder/API writes supply model, passthrough and culling only.
    await fs.writeFile(sidecar, serializer.serialize(model, parsed.passthrough, {}, metadata));
    return new DOMParser().parseFromString(await fs.readFile(sidecar, 'utf8'), 'application/xml');
  }

  it('preserves metadata XML, aliases, multiple languages and creators across saves', async () => {
    for (let save = 0; save < 2; save++) {
      const doc = await edit();
      const title = doc.getElementsByTagNameNS(DC, 'title');
      expect(title.length).toBe(1);
      expect(
        Array.from(title[0].getElementsByTagNameNS(RDF, 'li'), (li) => li.textContent),
      ).toEqual(['Original title', 'Titre original']);
      const creators = doc.getElementsByTagNameNS(DC, 'creator');
      expect(creators.length).toBe(1);
      expect(
        Array.from(creators[0].getElementsByTagNameNS(RDF, 'li'), (li) => li.textContent),
      ).toEqual(['First author', 'Second author']);
      expect(parser.parseMetadata(await fs.readFile(sidecar, 'utf8'))).toMatchObject({
        city: 'Paris',
        dateTimeOriginal: '2025-06-01T12:00:00+02:00',
      });
      expect(doc.getElementsByTagNameNS('https://vendor.test/', 'title')[0].textContent).toBe(
        'Foreign title',
      );
    }
  });

  it('explicit replacement owns metadata across descriptions without duplicating old fields', async () => {
    const doc = await edit({ title: 'New title', creator: 'New author', city: 'London' });
    expect(doc.getElementsByTagNameNS(DC, 'title').length).toBe(1);
    expect(doc.getElementsByTagNameNS(DC, 'creator').length).toBe(1);
    const xml = await fs.readFile(sidecar, 'utf8');
    expect(parser.parseMetadata(xml)).toMatchObject({
      title: 'New title',
      creator: 'New author',
      city: 'London',
    });
    expect(xml).not.toContain('Original title');
    expect(xml).not.toContain('Second author');
    expect(xml).not.toContain('DateTimeOriginal');
    expect(xml).toContain('Foreign title');
    expect(xml).toContain('Foreign sibling');
    expect(xml).toContain('vendor:Keep="untouched"');
  });

  it('an explicitly empty metadata replacement clears metadata but retains foreign content', async () => {
    const doc = await edit({});
    expect(doc.getElementsByTagNameNS(DC, 'title').length).toBe(0);
    expect(doc.getElementsByTagNameNS(DC, 'creator').length).toBe(0);
    const xml = await fs.readFile(sidecar, 'utf8');
    expect(xml).not.toContain('City=');
    expect(xml).not.toContain('DateTimeOriginal=');
    expect(xml).toContain('Foreign title');
    expect(xml).toContain('Foreign sibling');
  });
});
