import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { HostedRawSidecarService } from './hosted-raw-sidecar.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { fsAccessReadFile } from '../folder-access/fs-access-backend';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FilmLutService } from '../film/film-lut.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { RemovalCompanionBundle } from '../removal/removal-companion-bundle';
import { bundleRemovalCompanions } from '../removal/removal-companion-bundle';
import { runRemovalDerivative } from '../raw-pipeline/raw-pipeline.removal-handler';
import {
  initSync,
  NativeDetailSession,
  removal_asset_names,
  removal_saved_edit,
  removal_saved_list,
  render_bytes_sized,
} from '../raw-pipeline/pkg/raw_wasm';

const fixtures = resolve(process.cwd(), '../../test-fixtures/removal/calibration');
const bytes = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));
const text = (name: string) => new TextDecoder().decode(bytes(name));
const xmlFor = (records: string) =>
  `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="${records.replaceAll('"', '&quot;')}"/></rdf:RDF>`;

// Real nested RAW/XMP/assets and release WASM; only the worker transport is adapted.
describe('Hosted RAW derivatives retain accepted removals', () => {
  let root: string, folder: MapleFolderHandle, service: HostedRawSidecarService;
  const decode = vi.fn();
  const raw = bytes('source.dng');
  const records = text('records.txt');
  const location = { dir: 'nested', filename: 'photo.dng' };
  beforeAll(() =>
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    }),
  );
  beforeEach(async () => {
    decode.mockClear();
    root = await fs.mkdtemp(join(tmpdir(), 'maple-removal-derivative-'));
    await fs.mkdir(join(root, 'nested/.maple/inpaint'), { recursive: true });
    await fs.writeFile(join(root, 'nested/photo.dng'), raw);
    await fs.writeFile(join(root, 'nested/photo.xmp'), xmlFor(records));
    const names = JSON.parse(removal_asset_names(records)) as string[];
    for (const name of names)
      await fs.writeFile(
        join(root, 'nested/.maple/inpaint', name),
        bytes(name.endsWith('.mask') ? 'mask.mimf' : 'patch.f16'),
      );
    // An undo-retained orphan must not enter the exact referenced bundle.
    await fs.writeFile(join(root, 'nested/.maple/inpaint/orphan.f16'), new Uint8Array([1]));
    folder = {
      name: root,
      read: true,
      write: false,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: FolderAccessService, useValue: { readFile: fsAccessReadFile } },
        { provide: FilmLutService, useValue: { getLattice: async () => null } },
        {
          provide: RawPipelineService,
          useValue: {
            decode,
            savedPreview: {
              renderDerivative: async (
                input: { bytes: Uint8Array; ext: string },
                xml: string,
                bundle: RemovalCompanionBundle,
                cap: number,
              ) => {
                expect(JSON.parse(bundle.manifest)).toHaveLength(2);
                const result = runRemovalDerivative(input.ext, {
                  kind: 'derivative',
                  bytes: input.bytes.slice().buffer as ArrayBuffer,
                  xmp: xml,
                  manifest: bundle.manifest,
                  companions: bundle.bytes.slice().buffer as ArrayBuffer,
                  cap,
                });
                if (result.kind !== 'rendered') throw new Error('Unexpected derivative response');
                return { ...result.frame, rgb: new Uint8Array(result.frame.rgb) };
              },
            },
          },
        },
      ],
    });
    service = TestBed.inject(HostedRawSidecarService);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads nested XMP and produces accepted pixels without ordinary decode or orphan assets', async () => {
    const xml = await service.read(folder, location);
    const saved = await service.render(raw, 'dng', xml!, folder, location, false);
    const ordinary = render_bytes_sized(raw, 'dng', xmlFor('[]'), false, 1280);
    try {
      expect(saved.rgb).not.toEqual(ordinary.take_rgb());
    } finally {
      ordinary.free();
    }
    expect(decode).not.toHaveBeenCalled();
    expect(new Uint8Array(await fs.readFile(join(root, 'nested/photo.dng')))).toEqual(raw);
  });

  it('renders an entirely disabled schema-five stack as the original while verifying its assets', async () => {
    const [entry] = JSON.parse(removal_saved_list(records)) as { id: string }[];
    const disabled = removal_saved_edit(
      records,
      JSON.stringify({ schema: 1, action: 'set-active', id: entry.id, active: false }),
    );
    const saved = await service.render(raw, 'dng', xmlFor(disabled), folder, location, false);
    const ordinary = render_bytes_sized(raw, 'dng', xmlFor('[]'), false, 1280);
    try {
      expect(saved.rgb).toEqual(ordinary.take_rgb());
    } finally {
      ordinary.free();
    }
    expect(decode).not.toHaveBeenCalled();
  });

  it('refuses missing and corrupt companions without an unedited retry', async () => {
    const [name] = JSON.parse(removal_asset_names(records)) as string[];
    const path = join(root, 'nested/.maple/inpaint', name);
    await fs.writeFile(path, new Uint8Array([0]));
    await expect(
      service.render(raw, 'dng', xmlFor(records), folder, location, true),
    ).rejects.toThrow();
    await fs.rm(path);
    await expect(
      service.render(raw, 'dng', xmlFor(records), folder, location, true),
    ).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it('does not change a resident review stack when an independent disabled derivative renders or fails', async () => {
    const session = new NativeDetailSession(raw, 'dng');
    const names = JSON.parse(removal_asset_names(records)) as string[];
    const bundle = bundleRemovalCompanions(
      new Map(
        names.map((name) => [name, bytes(name.endsWith('.mask') ? 'mask.mimf' : 'patch.f16')]),
      ),
    );
    const xml = xmlFor(records);
    try {
      session.prepare_saved_removals(xml, bundle.manifest, bundle.bytes);
      const before = session.render_saved_preview(xml, 1280, new Uint8Array());
      const expected = before.take_rgb();
      before.free();
      const [entry] = JSON.parse(removal_saved_list(records)) as { id: string }[];
      const disabled = removal_saved_edit(
        records,
        JSON.stringify({ schema: 1, action: 'set-active', id: entry.id, active: false }),
      );
      await service.render(raw, 'dng', xmlFor(disabled), folder, location, false);
      await fs.writeFile(join(root, 'nested/.maple/inpaint', names[0]), new Uint8Array([0]));
      await expect(service.render(raw, 'dng', xml, folder, location, false)).rejects.toThrow();
      const after = session.render_saved_preview(xml, 1280, new Uint8Array());
      try {
        expect(after.take_rgb()).toEqual(expected);
      } finally {
        after.free();
      }
    } finally {
      session.free();
    }
  });
});
