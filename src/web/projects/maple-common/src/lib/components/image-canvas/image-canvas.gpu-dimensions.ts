import type { ImageCanvasService } from './image-canvas.service';

interface PresentedDimensions {
  readonly width: number;
  readonly height: number;
  readonly cropInputWidth?: number;
  readonly cropInputHeight?: number;
}

/** Keep crop sampling, painted dimensions and the visible transform in sync. */
export function publishGpuDimensions(
  canvas: Pick<ImageCanvasService, 'cropInputDimensions'>,
  dimensions: PresentedDimensions,
  recordPaintedDims: (width: number, height: number) => void,
  applyView: () => void,
): void {
  canvas.cropInputDimensions.set(
    dimensions.cropInputWidth && dimensions.cropInputHeight
      ? { w: dimensions.cropInputWidth, h: dimensions.cropInputHeight }
      : null,
  );
  recordPaintedDims(dimensions.width, dimensions.height);
  applyView();
}
