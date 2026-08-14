// Tests for `FaceThumbCrop`, the thin per-thumb-URL state wrapper around
// the pure `faceCropTransform` / `withNaturalDims` helpers in `people.vm.ts`.
//
// The math those helpers perform is already exhaustively covered by
// `people.vm.spec.ts` (padding, clamping, aspect compensation). What's
// NOT covered there — and is the actual behaviour this class adds — is:
//   - recording natural dims from an `<img>` `(load)` event, keyed by URL
//   - looking the right entry back up by URL when `transform()` is called
//   - falling back to the aspect-naïve transform when no dims are recorded
//     for that URL (or no URL is given at all)
// So these tests exercise the wiring, not the arithmetic, and cross-check
// results against `faceCropTransform`/`withNaturalDims` imported directly
// rather than hard-coding expected transform strings.
//
// No TestBed — `FaceThumbCrop` is a plain class (signal + two methods),
// same style as `people.vm.spec.ts`.

import { describe, it, expect } from 'vitest';
import type { Bbox } from '@maple-common';
import { FaceThumbCrop } from './face-thumb-crop';
import { faceCropTransform, withNaturalDims } from './people.vm';

/** A `(load)` event stub carrying just what `onImgLoad` reads off
 * `event.target`. Avoids needing a real `HTMLImageElement`/DOM. */
function loadEvent(naturalWidth: number, naturalHeight: number): Event {
  return { target: { naturalWidth, naturalHeight } } as unknown as Event;
}

const BBOX: Bbox = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };

describe('FaceThumbCrop.onImgLoad', () => {
  it('records natural dims for a url, keyed correctly', () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(800, 600));
    expect(crop.naturalDims().get('/a.jpg')).toEqual({ nw: 800, nh: 600 });
  });

  it('accumulates independent entries for different urls', () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(800, 600));
    crop.onImgLoad('/b.jpg', loadEvent(400, 400));
    expect(crop.naturalDims().get('/a.jpg')).toEqual({ nw: 800, nh: 600 });
    expect(crop.naturalDims().get('/b.jpg')).toEqual({ nw: 400, nh: 400 });
    expect(crop.naturalDims().size).toBe(2);
  });

  it('updates an existing url when it reloads with different dims', () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(800, 600));
    crop.onImgLoad('/a.jpg', loadEvent(1024, 768));
    expect(crop.naturalDims().get('/a.jpg')).toEqual({ nw: 1024, nh: 768 });
    expect(crop.naturalDims().size).toBe(1);
  });

  it('keeps the same map reference (via withNaturalDims) when the reload reports identical dims', () => {
    // Signal writes are only worth doing when something actually changed —
    // matches the reference-stability contract `withNaturalDims` documents.
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(800, 600));
    const first = crop.naturalDims();
    crop.onImgLoad('/a.jpg', loadEvent(800, 600));
    expect(crop.naturalDims()).toBe(first);
  });

  it('ignores a zero-sized load (broken image / not-yet-decoded)', () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(0, 600));
    expect(crop.naturalDims().has('/a.jpg')).toBe(false);
    crop.onImgLoad('/a.jpg', loadEvent(600, 0));
    expect(crop.naturalDims().has('/a.jpg')).toBe(false);
  });

  it('matches withNaturalDims called directly with the same inputs', () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(800, 600));
    const expected = withNaturalDims(new Map(), '/a.jpg', 800, 600);
    expect(crop.naturalDims()).toEqual(expected);
  });
});

describe('FaceThumbCrop.transform', () => {
  it('uses the aspect-naïve fallback when no url is given', () => {
    const crop = new FaceThumbCrop();
    expect(crop.transform(BBOX, null)).toBe(faceCropTransform(BBOX, null));
  });

  it('uses the aspect-naïve fallback when the url has no recorded dims yet', () => {
    const crop = new FaceThumbCrop();
    expect(crop.transform(BBOX, '/never-loaded.jpg')).toBe(faceCropTransform(BBOX, null));
  });

  it('feeds the recorded natural dims for that url into faceCropTransform', () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(600, 400));
    expect(crop.transform(BBOX, '/a.jpg')).toBe(faceCropTransform(BBOX, { nw: 600, nh: 400 }));
    // And it must actually differ from the no-dims fallback — otherwise this
    // test wouldn't be exercising the aspect-compensation path at all.
    expect(crop.transform(BBOX, '/a.jpg')).not.toBe(faceCropTransform(BBOX, null));
  });

  it("does not leak one url's dims onto a lookup for a different url", () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(600, 400));
    // '/b.jpg' was never loaded, so it must fall back — not silently reuse
    // '/a.jpg's dims just because it's the only entry in the map.
    expect(crop.transform(BBOX, '/b.jpg')).toBe(faceCropTransform(BBOX, null));
  });

  it('picks the right entry among several recorded urls', () => {
    const crop = new FaceThumbCrop();
    crop.onImgLoad('/a.jpg', loadEvent(600, 400));
    crop.onImgLoad('/b.jpg', loadEvent(400, 600));
    expect(crop.transform(BBOX, '/a.jpg')).toBe(faceCropTransform(BBOX, { nw: 600, nh: 400 }));
    expect(crop.transform(BBOX, '/b.jpg')).toBe(faceCropTransform(BBOX, { nw: 400, nh: 600 }));
  });
});
