import '@angular/compiler';
import { createApplication } from '@angular/platform-browser';
import { HostedRawSidecarService } from '../../projects/maple-common/src/lib/state/hosted-raw-sidecar.service';
import { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';
import { HostedPreviewResolver } from '../../projects/maple-common/src/lib/state/hosted-preview-resolver.service';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';
import { MapleCacheService } from '../../projects/maple-common/src/lib/maple-cache/maple-cache.service';
import { GPU_LIVE_RENDER_ENABLED } from '../../projects/maple-common/src/lib/raw-pipeline/gpu-live-render.token';
import {
  encodeDevelopedRenderToAvif,
  encodeDevelopedRenderToJpeg,
} from '../../projects/maple-common/src/lib/raw-pipeline/image-utils';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { fallbackReadFile } from '../../projects/maple-common/src/lib/folder-access/fallback-backend';
import type { MapleFolderHandle } from '../../projects/maple-common/src/lib/folder-access/folder-access.types';
import type { AssetId } from '../../projects/maple-common/src/lib/models/asset';
import init, {
  render_bytes_sized,
  render_bytes_sized_with_film,
} from '../../projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm';

interface Options {
  raw: number[];
  film?: boolean;
  fallback?: boolean;
  race?: boolean;
  failure?: 'malformed' | 'directory' | 'develop';
}
async function pixels(blob: Blob): Promise<Uint8ClampedArray> {
  const image = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, image.width, image.height).data;
  } finally {
    image.close();
  }
}
function equal(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return left.length === right.length && Array.from(left).every((value, i) => value === right[i]);
}

/** Production resolver, real OPFS/fallback files, actual WASM worker and codec.
 * Direct Rust/WASM render plus the same format encode supplies pixel evidence. */
async function stage(options: Options) {
  const root = await navigator.storage.getDirectory();
  const name = 'raw-cache-' + crypto.randomUUID();
  const native = await root.getDirectoryHandle(name, { create: true });
  const album = await native.getDirectoryHandle('album', { create: true });
  const rawBytes = new Uint8Array(options.failure === 'develop' ? [1, 2, 3] : options.raw);
  const xml =
    options.failure === 'malformed'
      ? '<x:xmpmeta><rdf:RDF>'
      : new XmpSerializerService().serialize({
          ...defaultAdjustmentModel(),
          exposure: -2,
          highlights: -65,
          filmLook: options.film ? 'color_negative_kodak_portra_400' : '',
          filmStrength: 100,
        });
  async function write(file: string, data: BlobPart) {
    const handle = await album.getFileHandle(file, { create: true });
    const writer = await handle.createWritable();
    await writer.write(data);
    await writer.close();
    return handle;
  }
  const rawHandle = await write('photo.dng', rawBytes);
  if (options.failure === 'directory')
    await album.getDirectoryHandle('photo.xmp', { create: true });
  else await write('photo.xmp', xml);
  const files = [new File([rawBytes], 'photo.dng'), new File([xml], 'photo.xmp')];
  for (const file of files)
    Object.defineProperty(file, 'webkitRelativePath', { value: `${name}/album/${file.name}` });
  if (options.fallback)
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined });
  // The backend detects property presence, so remove it for the Safari-style path.
  if (options.fallback) Reflect.deleteProperty(window, 'showDirectoryPicker');
  const folder: MapleFolderHandle = options.fallback
    ? { name, read: true, write: false, fallbackFiles: files }
    : { name, read: true, write: true, native };
  const source = async () => {
    const file = await rawHandle.getFile();
    return { size: file.size, lastModified: file.lastModified };
  };
  const bytes = async () => new Uint8Array(await (await rawHandle.getFile()).arrayBuffer());
  const snapshot = async () => {
    const file = await rawHandle.getFile();
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      source: { size: file.size, lastModified: file.lastModified },
    };
  };
  return { root, name, album, rawBytes, xml, folder, source, bytes, snapshot };
}
type Fixture = Awaited<ReturnType<typeof stage>>;
const id = 'fixtures:album/photo.dng' as AssetId;

function trackWrites(cache: MapleCacheService) {
  const writes: Promise<void>[] = [];
  const writePreview = cache.writePreview.bind(cache);
  cache.writePreview = (...args) => {
    const pending = writePreview(...args);
    writes.push(pending);
    return pending;
  };
  return async (count: number) => {
    for (let attempt = 0; attempt < 100 && writes.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (writes.length !== count)
      throw new Error(`Expected ${count} real cache writes, got ${writes.length}`);
    await Promise.all(writes);
  };
}

async function rejection(resolver: HostedPreviewResolver, fixture: Fixture) {
  const error = await resolver.resolve(id, fixture.bytes, fixture.source, fixture.snapshot).then(
    () => '',
    (cause) => String(cause),
  );
  const cacheExists = await fixture.album.getDirectoryHandle('.maple').then(
    () => true,
    () => false,
  );
  return { rejected: !!error, error, cacheExists };
}

async function evidence(fixture: Fixture, blob: Blob, withFilm: boolean) {
  const { rawBytes, xml, folder, album } = fixture;
  await init();
  const film = withFilm
    ? new Uint8Array(
        await (await fetch('/film-luts/color_negative_kodak_portra_400.mlut')).arrayBuffer(),
      )
    : null;
  const expected = film
    ? render_bytes_sized_with_film(rawBytes, 'dng', xml, true, 1280, film)
    : render_bytes_sized(rawBytes, 'dng', xml, true, 1280);
  const plain = render_bytes_sized(rawBytes, 'dng', undefined, true, 1280);
  try {
    const image = {
      width: expected.width,
      height: expected.height,
      rgb: expected.rgb,
      asShotTemperature: expected.as_shot_temperature,
      asShotTint: expected.as_shot_tint,
    };
    const expectedBlob =
      (await encodeDevelopedRenderToAvif(image)) ?? (await encodeDevelopedRenderToJpeg(image));
    const sidecarBytes = folder.fallbackFiles
      ? await fallbackReadFile(folder, 'album/photo.xmp')
      : new Uint8Array(
          await (await (await album.getFileHandle('photo.xmp')).getFile()).arrayBuffer(),
        );
    return {
      exactPixels: equal(await pixels(blob), await pixels(expectedBlob)),
      differsFromCamera: !equal(expected.rgb, plain.rgb),
      originalUnchanged: equal(await fixture.bytes(), rawBytes),
      xmpUnchanged: new TextDecoder().decode(sidecarBytes) === xml,
      mime: blob.type,
    };
  } finally {
    expected.free();
    plain.free();
  }
}

async function roundTrips(
  resolver: HostedPreviewResolver,
  fixture: Fixture,
  blob: Blob,
  cache: MapleCacheService,
  settleWrites: (count: number) => Promise<void>,
) {
  await settleWrites(1);
  const persisted = await cache.readPreview(
    fixture.folder,
    'album',
    'photo.dng',
    await fixture.source(),
  );
  if (!persisted) throw new Error('Preview was not persisted');
  const warm = await resolver.resolve(
    id,
    async () => {
      throw new Error('Warm cache decoded RAW again');
    },
    fixture.source,
  );
  await fixture.album.removeEntry('.maple', { recursive: true });
  const regenerated = await resolver.resolve(id, fixture.bytes, fixture.source, fixture.snapshot);
  await settleWrites(2);
  return {
    warmMatches: !!warm && equal(await pixels(warm), await pixels(blob)),
    coldMatches: !!regenerated && equal(await pixels(regenerated), await pixels(blob)),
  };
}

async function changedSidecar(
  resolver: HostedPreviewResolver,
  fixture: Fixture,
  app: Awaited<ReturnType<typeof createApplication>>,
) {
  const pipeline = app.injector.get(RawPipelineService);
  const decode = pipeline.decode.bind(pipeline);
  pipeline.decode = async (...args) => {
    const image = await decode(...args);
    const handle = await fixture.album.getFileHandle('photo.xmp');
    const writer = await handle.createWritable();
    await writer.write(
      new XmpSerializerService().serialize({ ...defaultAdjustmentModel(), exposure: 1 }),
    );
    await writer.close();
    return image;
  };
  const sidecars = app.injector.get(HostedRawSidecarService);
  const read = sidecars.read.bind(sidecars);
  const reads: Promise<string | null>[] = [];
  sidecars.read = (...args) => {
    const pending = read(...args);
    reads.push(pending);
    return pending;
  };
  const blob = await resolver.resolve(id, fixture.bytes, fixture.source, fixture.snapshot);
  for (let attempt = 0; attempt < 100 && reads.length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (reads.length !== 2) throw new Error('Missing sidecar publication recheck');
  await Promise.all(reads);
  const cacheExists = await fixture.album.getDirectoryHandle('.maple').then(
    () => true,
    () => false,
  );
  return { displayed: !!blob, cacheExists };
}

export async function run(options: Options) {
  const fixture = await stage(options);
  const app = await createApplication({
    providers: [
      { provide: GPU_LIVE_RENDER_ENABLED, useValue: false },
      {
        provide: LibraryStore,
        useValue: {
          findAsset: () => ({ id, filename: 'photo.dng' }),
          currentFolder: () => fixture.folder,
        },
      },
    ],
  });
  try {
    const resolver = app.injector.get(HostedPreviewResolver);
    const cache = app.injector.get(MapleCacheService);
    const settleWrites = trackWrites(cache);
    if (options.failure) return await rejection(resolver, fixture);
    if (options.race) return await changedSidecar(resolver, fixture, app);
    const blob = await resolver.resolve(id, fixture.bytes, fixture.source, fixture.snapshot);
    if (!blob) throw new Error('Missing authored preview');
    const result = await evidence(fixture, blob, options.film ?? false);
    if (options.fallback) return result;
    return { ...result, ...(await roundTrips(resolver, fixture, blob, cache, settleWrites)) };
  } finally {
    app.destroy();
    await fixture.root.removeEntry(fixture.name, { recursive: true });
  }
}
