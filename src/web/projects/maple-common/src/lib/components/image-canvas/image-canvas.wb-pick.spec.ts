// White-balance pick geometry + arm/resolve lifecycle (#2434).

import { normalisedImagePoint } from './image-canvas.wb-pick';
import { WbPickService } from './wb-pick.service';

/** A 400×300 image fitted, unpanned, in an 800×600 viewport. */
const FITTED = { wrapW: 800, wrapH: 600, canvasW: 400, canvasH: 300, pan: { x: 0, y: 0 } };

describe('normalisedImagePoint (#2434)', () => {
  it('maps the centre of the painted rect to the centre of the image', () => {
    expect(normalisedImagePoint(400, 300, FITTED)).toEqual({ nx: 0.5, ny: 0.5 });
  });

  it('maps the painted rect corners to the image corners', () => {
    // The rect is centred: x 200..600, y 150..450.
    expect(normalisedImagePoint(200, 150, FITTED)).toEqual({ nx: 0, ny: 0 });
    expect(normalisedImagePoint(600, 450, FITTED)).toEqual({ nx: 1, ny: 1 });
  });

  it('rejects a click on the letterbox rather than clamping it to an edge', () => {
    // A clamped point would sample the image border — a pixel the user did
    // not click. Outside the painted rect is "no sample", not "edge sample".
    expect(normalisedImagePoint(10, 300, FITTED)).toBeNull();
    expect(normalisedImagePoint(400, 20, FITTED)).toBeNull();
  });

  it('follows the pan so a click resolves to the pixel under the cursor', () => {
    const panned = { ...FITTED, pan: { x: 100, y: -50 } };
    // The rect moved right 100 and up 50, so its centre did too.
    expect(normalisedImagePoint(500, 250, panned)).toEqual({ nx: 0.5, ny: 0.5 });
    // What used to be the centre is now left and below of centre.
    const p = normalisedImagePoint(400, 300, panned);
    expect(p?.nx).toBeLessThan(0.5);
    expect(p?.ny).toBeGreaterThan(0.5);
  });

  it('resolves against the zoomed rect, not the fitted one', () => {
    const zoomed = { ...FITTED, canvasW: 1600, canvasH: 1200 };
    // Image rect: x -400..1200, y -300..900. The viewport centre is still
    // the image centre; a quarter of the way across the VIEWPORT is not.
    expect(normalisedImagePoint(400, 300, zoomed)).toEqual({ nx: 0.5, ny: 0.5 });
    expect(normalisedImagePoint(200, 300, zoomed)?.nx).toBeCloseTo(0.375, 6);
  });

  it('returns null for a degenerate (unpainted) rect instead of dividing by zero', () => {
    expect(normalisedImagePoint(0, 0, { ...FITTED, canvasW: 0, canvasH: 0 })).toBeNull();
  });
});

describe('WbPickService (#2434)', () => {
  it('resolves the armed pick with the clicked point and disarms', async () => {
    const svc = new WbPickService();
    const pending = svc.arm();
    expect(svc.active()).toBe(true);
    svc.resolve({ nx: 0.25, ny: 0.75 });
    await expect(pending).resolves.toEqual({ nx: 0.25, ny: 0.75 });
    expect(svc.active()).toBe(false);
  });

  it('cancel resolves null so the caller is never left waiting', async () => {
    const svc = new WbPickService();
    const pending = svc.arm();
    svc.cancel();
    await expect(pending).resolves.toBeNull();
    expect(svc.active()).toBe(false);
  });

  it('re-arming cancels the previous wait rather than stranding it', async () => {
    const svc = new WbPickService();
    const first = svc.arm();
    const second = svc.arm();
    await expect(first).resolves.toBeNull();
    svc.resolve({ nx: 0.1, ny: 0.2 });
    await expect(second).resolves.toEqual({ nx: 0.1, ny: 0.2 });
  });

  it('resolving when nothing is armed is a no-op', () => {
    const svc = new WbPickService();
    expect(() => svc.resolve({ nx: 0.5, ny: 0.5 })).not.toThrow();
    expect(svc.active()).toBe(false);
  });
});
