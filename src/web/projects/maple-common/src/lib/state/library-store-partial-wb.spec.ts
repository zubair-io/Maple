import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { LibraryStore } from './library-store.service';
import { LibraryStateService } from './library-state.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { EditorStateService } from '../editor/editor-state.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { buildTransferPatch } from '../editor/copy-paste/adjustment-transfer';
import type { AdjustmentModel } from '../models/adjustment-model';

const ID = 'asset-1';
const parser = new XmpParserService();
const serializer = new XmpSerializerService();
function xml(attrs: string): string {
  const stamp = attrs.includes('WbScaleVersion') ? '' : 'papp:WbScaleVersion="5"';
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:WhiteBalance="Custom" ${stamp} ${attrs}/></rdf:RDF></x:xmpmeta>`;
}

describe('real editor and store partial WB authors (#3434)', () => {
  let store: LibraryStore;
  let editor: EditorStateService;
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'maple-store-wb-'));
    path = join(directory, 'photo.xmp');
    const library = {
      assets: signal([{ id: ID, filename: 'photo.dng' }]),
      adjustmentFor: (id: string) => store.adjustmentFor(id),
      updateAdjustment: (id: string, patch: Partial<AdjustmentModel>) =>
        store.setAdjustment(id, patch),
      asShotWbFor: (id: string) => store.asShotWbFor(id),
      bytesFor: () => new Uint8Array([1]),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: LIBRARY_BACKEND, useValue: {} },
        { provide: LibraryStateService, useValue: library },
        {
          provide: RawPipelineService,
          useValue: {
            computeAutoAdjustments: async () => ({
              temperature: 5800,
              tint: 5,
              exposure: 0,
              contrast: 0,
              highlights: 0,
              shadows: 0,
              whites: 0,
              blacks: 0,
            }),
            sampleWhiteBalance: async () => ({ temperature: 4820, tint: -12, algorithmVersion: 1 }),
          },
        },
      ],
    });
    store = TestBed.inject(LibraryStore);
    editor = TestBed.inject(EditorStateService);
    editor.bind(ID);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function load(attrs = 'crs:Temperature="8500"'): void {
    writeFileSync(path, xml(attrs));
    store.restoreAdjustment(ID, parser.parseAdjustmentModel(readFileSync(path, 'utf8')).model);
    store.seedAsShotWhiteBalance(ID, 5520.125, -43.79, true);
  }
  function save(): string {
    writeFileSync(path, serializer.serialize(store.adjustmentFor(ID)()));
    return readFileSync(path, 'utf8');
  }

  it('hydrates correctly regardless of decode versus sidecar completion order', () => {
    load();
    expect(store.adjustmentFor(ID)().tint).toBe(-43.79);
    store.seedAsShotWhiteBalance('late-sidecar', 5520.125, -43.79, true);
    store.restoreAdjustment(
      'late-sidecar',
      parser.parseAdjustmentModel(xml('crs:Temperature="8500"')).model,
    );
    expect(store.adjustmentFor('late-sidecar')()).toEqual(store.adjustmentFor(ID)());
    store.setAdjustment(ID, { exposure: 1.25 });
    expect(save()).not.toContain('crs:Tint=');
  });

  it('keeps both imported and manually authored explicit defaults through a late camera callback', () => {
    load('crs:Temperature="6500" crs:Tint="0"');
    expect(store.adjustmentFor(ID)()).toMatchObject({
      temperature: 6500,
      tint: 0,
      partialWhiteBalance: null,
    });
    store.setAdjustment(ID, { temperature: 6500, tint: 0 });
    store.seedAsShotWhiteBalance(ID, 7600, 48, true);
    expect(store.adjustmentFor(ID)()).toMatchObject({ temperature: 6500, tint: 0 });
    expect(save()).toContain('crs:Tint="0"');
  });

  for (const route of ['restore', 'merge'] as const) {
    it(`${route} invalidates fit provenance for real persisted profile transitions only`, () => {
      const caps = store.lensCorrections;
      const replace = (profile: 'Auto' | 'Neutral', exposure = 0) => {
        writeFileSync(path, xml(`papp:Profile="${profile}" crs:Exposure2012="${exposure}"`));
        const bytes = readFileSync(path);
        const model = parser.parseAdjustmentModel(bytes.toString()).model;
        if (route === 'restore') expect(store.restoreAdjustment(ID, model)).toBe(true);
        else store.mergePersistedAdjustment(ID, model, {});
        expect(readFileSync(path)).toEqual(bytes);
        expect(store.adjustmentFor(ID)().profile).toBe(profile);
      };
      const oldRevision = caps.autoFitRevisionFor(ID);
      caps.seedProfile(ID, null, true, oldRevision);
      replace('Neutral');
      expect(caps.autoFitRevisionFor(ID)).toBe(oldRevision + 1);
      expect(caps.for(ID).autoFit).toBeUndefined();
      caps.seedProfile(ID, null, true, oldRevision);
      expect(caps.for(ID).autoFit).toBeUndefined();
      const neutralRevision = caps.autoFitRevisionFor(ID);
      caps.seedProfile(ID, null, false, neutralRevision);
      replace('Auto');
      expect(caps.autoFitRevisionFor(ID)).toBe(neutralRevision + 1);
      expect(caps.for(ID).autoFit).toBeUndefined();
      caps.seedProfile(ID, null, false, neutralRevision);
      expect(caps.for(ID).autoFit).toBeUndefined();
      const autoRevision = caps.autoFitRevisionFor(ID);
      caps.seedProfile(ID, null, true, autoRevision);
      replace('Auto', 1.25);
      expect(caps.autoFitRevisionFor(ID)).toBe(autoRevision);
      expect(caps.for(ID).autoFit).toBe(true);
    });
  }

  it('does not invalidate a rejected restore or an authored profile retained over persisted fields', () => {
    const caps = store.lensCorrections;
    const authored = store.setAdjustment(ID, { profile: 'Neutral' });
    const revision = caps.autoFitRevisionFor(ID);
    caps.seedProfile(ID, null, false, revision);
    writeFileSync(path, xml('papp:Profile="Auto"'));
    const original = readFileSync(path);
    const persisted = parser.parseAdjustmentModel(original.toString()).model;
    expect(store.restoreAdjustment(ID, persisted)).toBe(false);
    store.mergePersistedAdjustment(ID, persisted, authored);
    expect(store.adjustmentFor(ID)().profile).toBe('Neutral');
    expect(caps.autoFitRevisionFor(ID)).toBe(revision);
    expect(caps.for(ID).autoFit).toBe(false);
    expect(readFileSync(path)).toEqual(original);
  });

  it('an unrelated edit merged over a late sidecar hydrates the missing camera axis', () => {
    store.seedAsShotWhiteBalance(ID, 5520.125, -43.79, true);
    const authored = store.setAdjustment(ID, { exposure: 1.25 });
    const persisted = parser.parseAdjustmentModel(xml('crs:Temperature="8500"')).model;
    store.mergePersistedAdjustment(ID, persisted, authored);
    expect(store.adjustmentFor(ID)()).toMatchObject({
      temperature: 8500,
      tint: -43.79,
      exposure: 1.25,
    });
    expect(save()).not.toContain('crs:Tint=');
  });

  it('a late persisted base cannot resurrect partial intent after a manual default edit', () => {
    load();
    const persisted = store.adjustmentFor(ID)();
    const authored = store.setAdjustment(ID, { temperature: 6500, tint: 0 });
    expect(authored.partialWhiteBalance).toBeNull();
    store.mergePersistedAdjustment(ID, persisted, authored);
    expect(store.adjustmentFor(ID)().partialWhiteBalance).toBeNull();
    expect(save()).toContain('crs:Tint="0"');
  });

  for (const preset of ['Custom', 'Daylight', 'Auto', 'As Shot'] as const) {
    it(`${preset} authors WB and undo restores the original partial sidecar`, async () => {
      load();
      const imported = store.adjustmentFor(ID)();
      expect(await editor.applyWhiteBalancePreset(ID, preset)).toBe(true);
      const authored = store.adjustmentFor(ID)();
      expect(authored.partialWhiteBalance).toBeNull();
      const saved = save();
      if (preset === 'As Shot') expect(saved).not.toContain('crs:Temperature=');
      else {
        expect(saved).toContain('crs:Temperature=');
        expect(saved).toContain('crs:Tint=');
      }
      editor.undo();
      expect(store.adjustmentFor(ID)()).toEqual(imported);
      expect(save()).not.toContain('crs:Tint=');
      editor.redo();
      expect(store.adjustmentFor(ID)()).toEqual(authored);
    });
  }

  it('sampling a legacy partial import stamps the current solved scale', async () => {
    load('crs:Tint="40" papp:WbScaleVersion="1"');
    const before = store.adjustmentFor(ID)();
    expect(await editor.sampleWhiteBalanceAt(ID, 0.25, 0.75)).toBe(true);
    expect(store.adjustmentFor(ID)()).toMatchObject({
      temperature: 4820,
      tint: -12,
      wbScaleVersion: 5,
      partialWhiteBalance: null,
    });
    expect(parser.parseAdjustmentModel(save()).model).toMatchObject({
      temperature: 4820,
      tint: -12,
      wbScaleVersion: 5,
    });
    editor.undo();
    expect(store.adjustmentFor(ID)()).toEqual(before);
    expect(save()).not.toContain('crs:Temperature=');
  });

  it('manual same-value edits and absolute paste author complete pairs and undo restores intent', () => {
    load();
    const before = store.adjustmentFor(ID)();
    editor.commit();
    editor.armTool('temp');
    editor.setArmedDisplayValue(8500);
    editor.endEdit();
    expect(store.adjustmentFor(ID)().partialWhiteBalance).toBeNull();
    expect(save()).toContain('crs:Tint="-43.79"');
    editor.undo();
    expect(store.adjustmentFor(ID)()).toEqual(before);
    const patch = buildTransferPatch({
      source: before,
      groups: ['white_balance'],
      relativeWhiteBalance: false,
    });
    store.setAdjustment(ID, patch);
    expect(store.adjustmentFor(ID)().partialWhiteBalance).toBeNull();
    expect(save()).toContain('crs:Tint="-43.79"');
  });
});
