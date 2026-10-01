import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as workerThreads from 'node:worker_threads';
import { TestBed } from '@angular/core/testing';
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { initSync } from '../raw-pipeline/pkg/raw_wasm';
import { DiskDirectory } from '../editor/copy-paste/testing/batch-test-files';
import { fsAccessReadFile, fsAccessWriteFile } from '../folder-access/fs-access-backend';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { SidecarSaveStateService } from '../xmp/sidecar-save-state.service';
import { LocalRemovalAssets } from './local-removal-assets';

const fixtureRoot = resolve(process.cwd(), '../../test-fixtures/removal/basic');
const fixture = (name: string) => new Uint8Array(readFileSync(join(fixtureRoot, name)));
const text = (name: string) => new TextDecoder().decode(fixture(name));
const culling = { rating: 0, flag: 'unflagged' as const, colorLabel: null };

describe('durable browser removal through actual WASM and filesystem files', () => {
  let root: string;
  let folder: MapleFolderHandle;
  let assets: LocalRemovalAssets;
  let sidecars: XmpStoreService;
  const publish = () =>
    assets.publish(text('request.txt'), '[]', fixture('mask.mimf'), fixture('patch.f16'));
  const commit = (records: string, expected = '[]') =>
    sidecars.writeRemovalConfirmed(
      'photo',
      folder,
      'photo.dng',
      defaultAdjustmentModel(),
      culling,
      expected,
      records,
    );

  beforeAll(() => {
    initSync({
      module: readFileSync(
        resolve(process.cwd(), 'projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm_bg.wasm'),
      ),
    });
    // Node's real LockManager implements the Web Locks coordination protocol.
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: Reflect.get(workerThreads, 'locks'),
    });
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'maple-removal-'));
    await fs.writeFile(join(root, 'photo.dng'), fixture('source.dng'));
    await fs.writeFile(join(root, 'photo.xmp'), fixture('prior.xmp'));
    folder = {
      name: root,
      read: true,
      write: true,
      native: new DiskDirectory(root) as unknown as FileSystemDirectoryHandle,
    };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: FolderAccessService,
          useValue: { readFile: fsAccessReadFile, writeFile: fsAccessWriteFile },
        },
      ],
    });
    sidecars = TestBed.inject(XmpStoreService);
    assets = new LocalRemovalAssets(TestBed.inject(FolderAccessService), folder, 'photo.dng');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('publishes shared bytes idempotently and confirms XMP without changing the RAW or foreign XML', async () => {
    const records = await publish();
    expect(records).toBe(text('records.txt'));
    expect(await publish()).toBe(records);
    await commit(records);
    expect(TestBed.inject(SidecarSaveStateService).phase()).toBe('saved');
    const xml = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    expect(xml).toContain('foreign:Keep="untouched"');
    expect(xml).toContain('foreign:History');
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(
      fixture('source.dng'),
    );
    expect((await assets.read(records)).size).toBe(2);
    // Ordinary slider writes preserve the newly accepted stack even when their
    // cached passthrough was captured before Keep.
    sidecars.scheduleWrite(
      'photo',
      folder,
      'photo.dng',
      { ...defaultAdjustmentModel(), exposure: 1 },
      culling,
    );
    await sidecars.flushAsset('photo');
    const reopened = TestBed.inject(XmpParserService).parseAdjustmentModel(
      await fs.readFile(join(root, 'photo.xmp'), 'utf8'),
    );
    expect(
      reopened.passthrough.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value,
    ).toBe(records);
  });

  it('confirms and reopens the explicit calibration plate without downgrading it', async () => {
    const fixtureRequest: unknown = JSON.parse(text('request.txt'));
    if (
      typeof fixtureRequest !== 'object' ||
      fixtureRequest === null ||
      Array.isArray(fixtureRequest)
    ) {
      throw new Error('Invalid object-removal request fixture');
    }
    const request = JSON.stringify({ ...fixtureRequest, plate: 'linear-calibration-v1' });
    const records = await assets.publish(request, '[]', fixture('mask.mimf'), fixture('patch.f16'));
    expect(JSON.parse(records)).toMatchObject([
      { schema: 4, accepted: { plate: 'linear-calibration-v1' } },
    ]);
    await commit(records);
    const xml = await fs.readFile(join(root, 'photo.xmp'), 'utf8');
    const reopened = TestBed.inject(XmpParserService).parseAdjustmentModel(xml);
    expect(
      reopened.passthrough.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value,
    ).toBe(records);
    expect((await assets.read(records)).size).toBe(2);
    expect(new Uint8Array(await fs.readFile(join(root, 'photo.dng')))).toEqual(
      fixture('source.dng'),
    );
    const downgraded = records.replace('"schema":4', '"schema":3');
    await expect(assets.read(downgraded)).rejects.toThrow();
  });

  it('refuses stale XMP and missing companions without replacing the sidecar', async () => {
    const records = await publish();
    const before = await fs.readFile(join(root, 'photo.xmp'));
    await expect(commit(records, 'stale')).rejects.toThrow('photo changed');
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(before);
    const names = await fs.readdir(join(root, '.maple/inpaint'));
    await fs.rm(join(root, '.maple/inpaint', names[0]));
    await expect(commit(records)).rejects.toThrow();
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(before);
    expect(TestBed.inject(SidecarSaveStateService).phase()).toBe('error');
  });

  it('refuses a replaced original at publication and commit', async () => {
    const records = await publish();
    const before = await fs.readFile(join(root, 'photo.xmp'));
    await fs.writeFile(join(root, 'photo.dng'), 'replaced');
    await expect(publish()).rejects.toThrow('original changed');
    await expect(commit(records)).rejects.toThrow('original changed');
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(before);
  });

  it('detects corrupt existing immutable assets and retains prior sidecar bytes', async () => {
    const records = await publish();
    const names = await fs.readdir(join(root, '.maple/inpaint'));
    await fs.writeFile(join(root, '.maple/inpaint', names[0]), 'corrupt');
    await expect(assets.read(records)).rejects.toThrow();
    await expect(publish()).rejects.toThrow();
    expect(await fs.readFile(join(root, 'photo.xmp'))).toEqual(Buffer.from(fixture('prior.xmp')));
  });
});
