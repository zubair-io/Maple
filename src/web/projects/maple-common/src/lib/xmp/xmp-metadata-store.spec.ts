import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { expect, it } from 'vitest';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { fsAccessWriteFile } from '../folder-access/fs-access-backend';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { XmpParserService } from './xmp-parser.service';
import { XmpStoreService } from './xmp-store.service';

it('retains source languages and authors when ordinary hydration also caches typed metadata', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'maple-metadata-store-'));
  const path = join(root, 'photo.xmp');
  const original = new Uint8Array([1, 3, 5, 7]);
  try {
    await fs.writeFile(join(root, 'photo.dng'), original);
    await fs.writeFile(
      path,
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Title</rdf:li><rdf:li xml:lang="fr">Titre</rdf:li></rdf:Alt></dc:title>
          <dc:creator><rdf:Seq><rdf:li>Alice</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>
        </rdf:Description>
      </rdf:RDF>
    </x:xmpmeta>`,
    );
    TestBed.configureTestingModule({
      providers: [{ provide: FolderAccessService, useValue: { writeFile: fsAccessWriteFile } }],
    });
    const parser = TestBed.inject(XmpParserService);
    const store = TestBed.inject(XmpStoreService);
    const source = parser.parseAdjustmentModel(await fs.readFile(path, 'utf8'));
    store.replacePassthroughs(
      ['photo'],
      new Map([['photo', source.passthrough]]),
      new Map([['photo', source.metadata]]),
    );
    store.scheduleWrite(
      'photo',
      {
        name: 'photos',
        read: true,
        write: true,
        native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
      },
      'photo.dng',
      { ...defaultAdjustmentModel(), exposure: 1 },
      { rating: 0, flag: 'unflagged', colorLabel: null },
    );
    await store.flushAsset('photo');
    const xml = await fs.readFile(path, 'utf8');
    expect(xml).toContain('crs:Exposure2012="1"');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const dc = 'http://purl.org/dc/elements/1.1/';
    const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const values = (local: string) =>
      Array.from(
        doc.getElementsByTagNameNS(dc, local)[0].getElementsByTagNameNS(rdf, 'li'),
        (element) => element.textContent,
      );
    expect(values('title')).toEqual(['Title', 'Titre']);
    expect(values('creator')).toEqual(['Alice', 'Bob']);
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
