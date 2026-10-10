// Selection alone uses this display-referred proxy. Reconstruction consumes
// the retained RAW's native f32 calibration context, never these 8-bit pixels.
export interface RemovalProxy {
  width: number;
  height: number;
  rgb: Uint8Array;
}

export async function selectionTensors(
  proxy: RemovalProxy,
  width: number,
  height: number,
): Promise<{
  inputWidth: number;
  inputHeight: number;
  encoder: Float32Array;
  detector: Float32Array;
}> {
  const longest = Math.max(width, height);
  const inputWidth = longest <= 1024 ? width : Math.max(1, Math.round((width * 1024) / longest));
  const inputHeight = longest <= 1024 ? height : Math.max(1, Math.round((height * 1024) / longest));
  const rgba = new Uint8ClampedArray(proxy.width * proxy.height * 4);
  for (let pixel = 0; pixel < proxy.width * proxy.height; pixel++) {
    rgba.set(proxy.rgb.subarray(pixel * 3, pixel * 3 + 3), pixel * 4);
    rgba[pixel * 4 + 3] = 255;
  }
  const bitmap = await createImageBitmap(new ImageData(rgba, proxy.width, proxy.height));
  const tensor = (side: number, w: number, h: number, scale: number) => {
    const canvas = new OffscreenCanvas(side, side);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Selection image preparation is unavailable.');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, side, side).data;
    const plane = side * side,
      result = new Float32Array(3 * plane);
    for (let index = 0; index < plane; index++)
      for (let channel = 0; channel < 3; channel++)
        result[channel * plane + index] = data[4 * index + channel] / scale;
    return result;
  };
  try {
    return {
      inputWidth,
      inputHeight,
      encoder: tensor(1024, inputWidth, inputHeight, 1),
      detector: tensor(640, 640, 640, 255),
    };
  } finally {
    bitmap.close();
  }
}
