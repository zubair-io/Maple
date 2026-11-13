import type { ImageCanvasService } from './image-canvas.service';

interface PresentedDimensions {
  readonly cropInputWidth?: number;
  readonly cropInputHeight?: number;
}

/** Keep the removal overlay's crop sampling in sync with the presented frame. */
export function publishCropInputDimensions(
  canvas: Pick<ImageCanvasService, 'cropInputDimensions'>,
  dimensions: PresentedDimensions,
): void {
  canvas.cropInputDimensions.set(
    dimensions.cropInputWidth && dimensions.cropInputHeight
      ? { w: dimensions.cropInputWidth, h: dimensions.cropInputHeight }
      : null,
  );
}
