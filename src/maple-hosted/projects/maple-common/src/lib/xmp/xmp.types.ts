// XMP types used by the minimal culling parser (slice-10a).
// The full XMP model (adjust struct, IPTC, history) is spec § 05 work.

export type XmpFlag = 'pick' | 'reject' | 'unflagged';

export type XmpColorLabel =
  | 'red' | 'orange' | 'yellow' | 'green' | 'blue'
  | null;

export interface XmpCulling {
  rating: number;          // 0..5, defaults to 0
  flag: XmpFlag;
  colorLabel: XmpColorLabel;
}
