import '@angular/compiler';
import init, {
  WebLiveSession,
  render_bytes_sized,
} from '../../projects/maple-common/src/lib/raw-pipeline/pkg/raw_wasm';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { hydratePartialWhiteBalance } from '../../projects/maple-common/src/lib/models/partial-white-balance';
import {
  buildLiveParams,
  canUseLiveFastPath,
} from '../../projects/maple-common/src/lib/components/image-canvas/image-canvas.live-params';

await init();
const api = {
  ready: true,
  async check(raw: number[], axis: string, version: number, fast = false, asShot = false) {
    if (!navigator.gpu) throw new Error('This regression needs a real WebGPU adapter.');
    const profile = fast ? 'Auto' : 'Neutral';
    const preset = asShot ? 'As Shot' : 'Custom';
    const scalarOnly = fast ? 'crs:Sharpness="0" crs:ColorNoiseReduction="0"' : '';
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:WhiteBalance="${preset}" papp:Profile="${profile}" papp:WbScaleVersion="${version}" ${scalarOnly} ${axis}/></rdf:RDF></x:xmpmeta>`;
    const bytes = new Uint8Array(raw);
    const core = render_bytes_sized(bytes, 'dng', xml, false, 1024);
    const camera = { temperature: core.as_shot_temperature, tint: core.as_shot_tint };
    const reference = Array.from(core.take_rgb());
    const [width, height] = [core.width, core.height];
    core.free();
    const parser = new XmpParserService();
    const serializer = new XmpSerializerService();
    const imported = { ...defaultAdjustmentModel(), ...parser.parseAdjustmentModel(xml).model };
    const hydrated = hydratePartialWhiteBalance(imported, camera.temperature, camera.tint, true);
    if (canUseLiveFastPath(hydrated) !== fast)
      throw new Error('The white-balance fast-path gate did not preserve authorship.');
    const saved = serializer.serialize(hydrated);
    const canvas = new OffscreenCanvas(width, height);
    const session = await WebLiveSession.open(bytes, 'dng', saved, canvas, 1024, 'srgb');
    try {
      await session.render(saved);
      const fullLive = fast ? await readPixels(canvas, width, height) : undefined;
      if (fast) await session.render_with_params(buildLiveParams(hydrated));
      const live = await readPixels(canvas, width, height);
      return {
        live,
        reference: fullLive ?? reference,
        coreReference: reference,
        width,
        height,
        camera,
        saved,
        colorSpace: session.colorSpace,
      };
    } finally {
      session.free();
    }
  },
};
async function readPixels(canvas: OffscreenCanvas, width: number, height: number) {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const image = await createImageBitmap(blob);
  try {
    const copy = new OffscreenCanvas(width, height);
    const context = copy.getContext('2d', { colorSpace: 'srgb' })!;
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, width, height).data;
    return Array.from(rgba).filter((_, i) => i % 4 !== 3);
  } finally {
    image.close();
  }
}
Object.assign(window, { partialWbTest: api });
export type PartialWbBrowserTest = typeof api;
