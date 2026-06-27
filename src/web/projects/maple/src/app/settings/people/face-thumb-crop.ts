// FaceThumbCrop — face-thumbnail crop-transform state, extracted from
// `PeopleComponent` to satisfy the 600-LOC file budget.
//
// A face thumb is rendered with `object-fit: cover`, which letterboxes the
// source image to a square. To land the detector bbox where it actually is,
// `transform()` must compensate for that letterbox — which needs the source
// image's NATURAL pixel dimensions. We capture those from each `<img>`'s
// `(load)` event, keyed by thumb URL, and thread them through the pure
// `faceCropTransform` helper in `people.vm.ts`.
//
// Plain class (mirrors `ThumbBlobCache` / `PeopleBulkController`): a signal +
// two methods, no injection context needed. Shared by the list-view cover
// thumbs and the detail-view face grid.

import { signal } from '@angular/core';
import { type Bbox } from '@maple-common';
import { faceCropTransform, type NaturalDims, withNaturalDims } from './people.vm';

export class FaceThumbCrop {
  /** Natural pixel dimensions of each face-thumb's source image, keyed by
   * thumb URL. Populated from the `<img>` `(load)` event. */
  readonly naturalDims = signal<ReadonlyMap<string, NaturalDims>>(new Map());

  /** Record the natural dimensions of a freshly-loaded thumb `<img>`. */
  onImgLoad(url: string, event: Event): void {
    const img = event.target as HTMLImageElement;
    this.naturalDims.set(
      withNaturalDims(this.naturalDims(), url, img.naturalWidth, img.naturalHeight),
    );
  }

  /** CSS transform that crops the thumb to the bbox, compensating for the
   * `object-fit: cover` letterbox using the captured natural dimensions. */
  transform(bbox: Bbox, url: string | null): string {
    const dims = url ? (this.naturalDims().get(url) ?? null) : null;
    return faceCropTransform(bbox, dims);
  }
}
