import type { RawPipelineService } from '../../projects/maple-common/src/lib/raw-pipeline/raw-pipeline.service';

export async function workflowExportPixels(
  pipeline: RawPipelineService,
  bytes: Uint8Array,
  xml: string,
) {
  const output = await pipeline.exportImage(
    bytes,
    'dng',
    { format: 'png', quality: 100, colorSpace: 'srgb' },
    xml,
  );
  const bitmap = await createImageBitmap(output.blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return JSON.stringify([...context.getImageData(0, 0, bitmap.width, bitmap.height).data]);
  } finally {
    bitmap.close();
  }
}
