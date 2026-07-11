// xmp-wb-scale.ts — WB slider-scale version resolution (#1780/#1875/#1893).
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
// convention, which V4 matches exactly: the #1875 direction AND the #1893
// `kTintScale` magnitude) or no authored WB (nothing to convert) — is 4.
//
// V2/V3 → V4 load-normalization: the #1756–#1875 (V2) scale's tint axis
// was inverted vs ACR and, like V3, its magnitude was the legacy 1e-4 uv
// per unit — ACR's `kTintScale` (1/3000 uv per unit, V4) is 3.33× larger,
// so a legacy tint's displacement re-expresses in V4 by the 0.3 factor
// (negated as well for V2). The caller multiplies the parsed `crs:Tint`
// by `authoredTintFactor` (after its attribute walk) and stores the model
// as version 4, so the in-memory model and every re-serialize are
// uniformly V4. V1 deliberately does NOT load-normalize — its conversion
// needs the image's calibration frame, so raw-core converts it at develop
// and the sidecar round-trips as V1.

/** Legacy (V2/V3, 1e-4 uv per unit) → V4 (`kTintScale`, 1/3000 uv per
 * unit) tint multiplier — mirrors raw-core's `TINT_SCALE_V3_TO_V4`. */
export const TINT_SCALE_V3_TO_V4 = 0.3;

export interface WbScaleResolution {
  /** The version to store on the model (never 2 or 3 — both normalize to 4). */
  modelVersion: number;
  /**
   * Multiplier the caller applies to the parsed `crs:Tint` (1 when no
   * conversion applies): −0.3 for V2-authored (axis flip + rescale),
   * 0.3 for V3-authored (rescale), 1 for V1 (develop-time conversion in
   * raw-core) and V4 (current scale).
   */
  authoredTintFactor: number;
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
  const stamp =
    stampRaw === '1'
      ? 1
      : stampRaw === '2'
        ? 2
        : stampRaw === '3'
          ? 3
          : stampRaw === '4'
            ? 4
            : undefined;
  const version = stamp ?? (sawPappAnywhere && sawExplicitWb ? 1 : 4);
  const factor =
    !sawAuthoredTint || version === 1 || version === 4
      ? 1
      : version === 2
        ? -TINT_SCALE_V3_TO_V4
        : TINT_SCALE_V3_TO_V4;
  return {
    modelVersion: version === 2 || version === 3 ? 4 : version,
    authoredTintFactor: factor,
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
