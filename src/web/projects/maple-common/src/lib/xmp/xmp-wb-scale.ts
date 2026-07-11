// xmp-wb-scale.ts — WB slider-scale version resolution (#1780/#1875).
// Split out of `xmp-parser.service.ts` for the 600-line file budget, the
// same split the Swift side made in #1780 (`XMPSerialization+Attrs.swift`).
//
// Resolution rule (mirrors raw-core's `xmp::parse` and the Swift
// `XMPParser`): an explicit `papp:WbScaleVersion` stamp wins; otherwise a
// document carrying the Maple `papp:` namespace (declaration or attribute
// — every Maple writer declares it unconditionally; the PREFIX is the
// discriminator because the three Maple writers historically bound `papp`
// to different URIs) AND an explicit authored `crs:Temperature`/`crs:Tint`
// predates the versioning (pre-#1756 scale, 1). Everything else — no
// `papp:` namespace at all (ACR/Lightroom-authored, expressed in ACR's own
// convention, which V3 matches) or no authored WB (nothing to convert) —
// is 3.
//
// V2 → V3 load-normalization (#1875): the #1756–#1875 scale's tint axis
// was inverted vs ACR, so a V2-authored crs:Tint encodes the opposite
// displacement in the V3 axis. The caller negates the parsed tint (after
// its attribute walk) and stores the model as version 3, so the in-memory
// model and every re-serialize are uniformly V3.

export interface WbScaleResolution {
  /** The version to store on the model (never 2 — V2 normalizes to 3). */
  modelVersion: number;
  /** Whether the caller must negate the parsed `crs:Tint` (V2-authored). */
  negateAuthoredTint: boolean;
}

/**
 * Resolve the WB scale version for a parsed `rdf:Description` element.
 * `sawPappAnywhere` is the document-level Maple-authorship flag (any
 * element carrying `xmlns:papp` or a `papp:`-prefixed attribute).
 */
export function resolveWbScaleVersion(desc: Element, sawPappAnywhere: boolean): WbScaleResolution {
  const sawExplicitWb =
    desc.getAttribute('crs:Temperature') !== null || desc.getAttribute('crs:Tint') !== null;
  const sawAuthoredTint = desc.getAttribute('crs:Tint') !== null;
  const stampRaw = desc.getAttribute('papp:WbScaleVersion');
  const stamp = stampRaw === '1' ? 1 : stampRaw === '2' ? 2 : stampRaw === '3' ? 3 : undefined;
  const version = stamp ?? (sawPappAnywhere && sawExplicitWb ? 1 : 3);
  return {
    modelVersion: version === 2 ? 3 : version,
    negateAuthoredTint: version === 2 && sawAuthoredTint,
  };
}

/**
 * WB preset a parsed model should carry when the sidecar authored a
 * `crs:Temperature`/`crs:Tint` but no `crs:WhiteBalance` attribute: that is
 * a Custom WB — the same rule raw-core's parser encodes via its
 * `temperature_seen`/`tint_seen` flags. Recording 'Custom' keeps the
 * serializer's As-Shot gate (#1892) from dropping those authored values on
 * the next save (sidecars written before the gate never stamped a preset
 * alongside slider edits). Returns `undefined` when nothing should change:
 * an explicit preset was parsed, or no WB fields were authored.
 */
export function inferredWbPresetForAuthoredPair(
  parsedPreset: string | undefined,
  appliedModelKeys: ReadonlySet<string>,
): 'Custom' | undefined {
  const authoredPair = appliedModelKeys.has('temperature') || appliedModelKeys.has('tint');
  return parsedPreset === undefined && authoredPair ? 'Custom' : undefined;
}
