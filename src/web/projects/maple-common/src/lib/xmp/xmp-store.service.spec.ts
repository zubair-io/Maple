import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { SidecarSaveStateService } from './sidecar-save-state.service';
import { XmpStoreService } from './xmp-store.service';
import { XmpParserService } from './xmp-parser.service';

const FOLDER: MapleFolderHandle = { name: 'raws', read: true, write: true };
const CULLING = { rating: 0, flag: 'unflagged' as const, colorLabel: null, keywords: [] };

describe('XmpStoreService persistence contract', () => {
  let store: XmpStoreService;
  let saveState: SidecarSaveStateService;
  let writeFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeFile = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [{ provide: FolderAccessService, useValue: { writeFile } }],
    });
    store = TestBed.inject(XmpStoreService);
    saveState = TestBed.inject(SidecarSaveStateService);
  });

  afterEach(() => vi.useRealTimers());

  it('starts a real sibling-XMP write at 200ms and reports it saved', async () => {
    const model = { ...defaultAdjustmentModel(), exposure: 1.25 };
    store.scheduleWrite('asset-1', FOLDER, 'IMG_0001.dng', model, CULLING);

    await vi.advanceTimersByTimeAsync(199);
    expect(writeFile).not.toHaveBeenCalled();
    expect(saveState.phase()).toBe('unsaved');

    await vi.advanceTimersByTimeAsync(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [, filename, bytes] = writeFile.mock.calls[0];
    expect(filename).toBe('IMG_0001.xmp');
    expect(new TextDecoder().decode(bytes)).toContain('crs:Exposure2012="1.25"');
    expect(saveState.phase()).toBe('saved');
  });

  it('flushAll waits for a write whose debounce already fired', async () => {
    let finishWrite!: () => void;
    writeFile.mockImplementation(() => new Promise<void>((resolve) => (finishWrite = resolve)));
    store.scheduleWrite('asset-1', FOLDER, 'IMG_0001.dng', defaultAdjustmentModel(), CULLING);
    await vi.advanceTimersByTimeAsync(200);

    let flushed = false;
    const flush = store.flushAll().then(() => (flushed = true));
    await Promise.resolve();
    expect(flushed).toBe(false);

    finishWrite();
    await flush;
    expect(flushed).toBe(true);
  });

  it('serializes writes for one asset so an older write cannot win', async () => {
    const completions: Array<() => void> = [];
    writeFile.mockImplementation(() => new Promise<void>((resolve) => completions.push(resolve)));

    store.scheduleWrite(
      'asset-1',
      FOLDER,
      'IMG_0001.dng',
      { ...defaultAdjustmentModel(), exposure: 1 },
      CULLING,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(writeFile).toHaveBeenCalledTimes(1);

    store.scheduleWrite(
      'asset-1',
      FOLDER,
      'IMG_0001.dng',
      { ...defaultAdjustmentModel(), exposure: 2 },
      CULLING,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(writeFile).toHaveBeenCalledTimes(1);

    completions[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeFile).toHaveBeenCalledTimes(2);
    const xml = new TextDecoder().decode(writeFile.mock.calls[1]![2]);
    expect(xml).toContain('crs:Exposure2012="2"');

    completions[1]!();
    await store.flushAll();
    expect(saveState.phase()).toBe('saved');
  });

  it('keeps the edit unsaved and rejects flush when the filesystem write fails', async () => {
    writeFile.mockRejectedValue(new Error('Permission revoked'));
    store.scheduleWrite('asset-1', FOLDER, 'IMG_0001.dng', defaultAdjustmentModel(), CULLING);

    await expect(store.flushAll()).rejects.toThrow('Permission revoked');
    expect(saveState.phase()).toBe('error');
    expect(saveState.hasUnsavedChanges()).toBe(true);
  });

  it('preserves unknown XMP content through a sibling write and reload parse', async () => {
    const parser = TestBed.inject(XmpParserService);
    const source = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"
  xmlns:vendor="https://example.test/vendor?a=1&amp;b=2"
  xmlns:exif="http://ns.adobe.com/exif/1.0/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="0.75"
      vendor:Workflow="approved">
      <vendor:Recipe><rdf:li>keep me</rdf:li></vendor:Recipe>
      <exif:PrivateData>preserve me</exif:PrivateData>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
    const loaded = parser.parseAdjustmentModel(source);
    store.rememberPassthrough('asset-1', loaded.passthrough);

    store.scheduleWrite(
      'asset-1',
      FOLDER,
      'IMG_0001.dng',
      { ...defaultAdjustmentModel(), ...loaded.model, exposure: 1.5 },
      { rating: 4, flag: 'pick', colorLabel: 'red', keywords: ['portfolio'] },
    );
    await store.flushAll();

    const savedXml = new TextDecoder().decode(writeFile.mock.calls[0]![2]);
    expect(savedXml).toContain(loaded.passthrough.unknownNodes[0]);
    expect(savedXml).toContain('xmlns:exif="http://ns.adobe.com/exif/1.0/"');
    expect(new DOMParser().parseFromString(savedXml, 'text/xml').querySelector('parseerror')).toBe(
      null,
    );
    const reloaded = parser.parseAdjustmentModel(savedXml);
    expect(reloaded.model.exposure).toBe(1.5);
    expect(reloaded.passthrough.unknownNamespaces).toContainEqual({
      prefix: 'vendor',
      uri: 'https://example.test/vendor?a=1&b=2',
    });
    expect(parser.parseCulling(savedXml)).toEqual({
      rating: 4,
      flag: 'pick',
      colorLabel: 'red',
      keywords: ['portfolio'],
    });
    expect(reloaded.passthrough.unknownAttributes).toContainEqual({
      name: 'vendor:Workflow',
      value: 'approved',
    });
    expect(reloaded.passthrough.unknownNodes.join('\n')).toContain('<vendor:Recipe');
    expect(reloaded.passthrough.unknownNodes.join('\n')).toContain('keep me');
    expect(reloaded.passthrough.unknownNodes.join('\n')).toContain('exif:PrivateData');
  });

  it('recovers from permission loss after a later sibling write succeeds', async () => {
    writeFile.mockRejectedValueOnce(new Error('Permission revoked'));
    store.scheduleWrite('asset-1', FOLDER, 'IMG_0001.dng', defaultAdjustmentModel(), CULLING);
    await expect(store.flushAll()).rejects.toThrow('Permission revoked');

    writeFile.mockResolvedValue(undefined);
    store.scheduleWrite(
      'asset-1',
      FOLDER,
      'IMG_0001.dng',
      { ...defaultAdjustmentModel(), exposure: 0.5 },
      CULLING,
    );
    await store.flushAll();

    expect(saveState.phase()).toBe('saved');
    expect(saveState.error()).toBeNull();
    expect(saveState.hasUnsavedChanges()).toBe(false);
  });
});
