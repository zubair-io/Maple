import type { DetailRect } from '../../raw-pipeline/raw-pipeline.native-detail.types';

export interface DetailView {
  nativeW: number;
  nativeH: number;
  canvasW: number;
  canvasH: number;
  wrapW: number;
  wrapH: number;
  pan: { x: number; y: number };
}

/** Source coordinates use the oriented, DefaultCrop-relative native extent. */
export function visibleDetailRect(view: DetailView): DetailRect | null {
  const { nativeW, nativeH, canvasW, canvasH, wrapW, wrapH, pan } = view;
  if (
    ![nativeW, nativeH, canvasW, canvasH, wrapW, wrapH].every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isFinite(pan.x) ||
    !Number.isFinite(pan.y)
  )
    return null;
  const dx = (wrapW - canvasW) / 2 + pan.x;
  const dy = (wrapH - canvasH) / 2 + pan.y;
  const x = Math.max(0, Math.floor((-dx * nativeW) / canvasW));
  const y = Math.max(0, Math.floor((-dy * nativeH) / canvasH));
  const right = Math.min(nativeW, Math.ceil(((wrapW - dx) * nativeW) / canvasW));
  const bottom = Math.min(nativeH, Math.ceil(((wrapH - dy) * nativeH) / canvasH));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export function containsDetailRect(outer: DetailRect, inner: DetailRect): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/** One patch with modest pan headroom; raw-core adds its own exact filter halo. */
export function expandDetailRect(rect: DetailRect, nativeW: number, nativeH: number): DetailRect {
  const margin = Math.ceil(Math.min(Math.max(rect.width, rect.height) / 8, 256));
  const x = Math.max(0, rect.x - margin);
  const y = Math.max(0, rect.y - margin);
  return {
    x,
    y,
    width: Math.min(nativeW, rect.x + rect.width + margin) - x,
    height: Math.min(nativeH, rect.y + rect.height + margin) - y,
  };
}
