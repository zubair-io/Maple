import type { SeamConstraintRegion, SeamConstraintsRequest } from '../api/pano.service';

export interface SeamPoint {
  x: number;
  y: number;
}
export type SeamCanvas = SeamConstraintsRequest['canvas'];
export type SeamRect = Pick<SeamConstraintRegion, 'x' | 'y' | 'width' | 'height'>;

export function validSeamCanvas(canvas: SeamCanvas): boolean {
  return [canvas.width, canvas.height].every(
    (value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff,
  );
}

export function validSeamRect(rect: SeamRect, canvas: SeamCanvas): boolean {
  return (
    validSeamCanvas(canvas) &&
    Object.values(rect).every(Number.isInteger) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width <= canvas.width &&
    rect.y + rect.height <= canvas.height
  );
}

export function seamPoint(
  client: SeamPoint,
  bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  canvas: SeamCanvas,
): SeamPoint | null {
  if (!validSeamCanvas(canvas) || bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: Math.max(
      0,
      Math.min(canvas.width, ((client.x - bounds.left) * canvas.width) / bounds.width),
    ),
    y: Math.max(
      0,
      Math.min(canvas.height, ((client.y - bounds.top) * canvas.height) / bounds.height),
    ),
  };
}

export function seamDragRect(
  start: SeamPoint,
  end: SeamPoint,
  canvas: SeamCanvas,
): SeamRect | null {
  if (start.x === end.x || start.y === end.y) return null;
  const x = Math.max(0, Math.floor(Math.min(start.x, end.x)));
  const y = Math.max(0, Math.floor(Math.min(start.y, end.y)));
  const right = Math.min(canvas.width, Math.ceil(Math.max(start.x, end.x)));
  const bottom = Math.min(canvas.height, Math.ceil(Math.max(start.y, end.y)));
  const rect = { x, y, width: right - x, height: bottom - y };
  return validSeamRect(rect, canvas) ? rect : null;
}
