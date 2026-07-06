// XMPSerialization+Attrs.swift — the ordered adjustment + culling
// attribute list for the XMP serializer. Split out of
// `XMPSerialization.swift` in #1780 (the `papp:WbScaleVersion` stamp
// pushed the file past the 600-line hard budget; see CONTRIBUTING.md).
// Used by both `XMPSerializer.serialize` overloads — the plain
// model+culling form here and the metadata overload in
// `XMPSerialization+MetadataWrite.swift`.

import Foundation

extension XMPSerializer {
    /// Build the ordered adjustment + culling attribute list.
    /// Values are already formatted for direct emission (numbers, rawValues,
    /// "Red"/"Rejected" — all XML-safe without escaping).
    /// Called from both `serialize(model:culling:)` and the metadata overload
    /// so metadata attrs can be appended natively.
    static func _buildAttrs(model: AdjustmentModel, culling: CullingState) -> [(String, String)] {
        var attrs: [(String, String)] = [
            ("crs:Temperature",          String(format: "%.0f", model.temperature)),
            ("crs:Tint",                 String(format: "%.0f", model.tint)),
            // WB scale stamp (#1780): this serializer always writes explicit
            // Temperature/Tint, so the scale those numbers are expressed in
            // is always stamped alongside them. Re-emits the version the
            // model was loaded with (1 for pre-#1756 sidecars, 2 for fresh
            // models) so a V1 sidecar's stored values keep their meaning
            // across saves. Clamped to {1, 2} (default 2): raw-core's
            // parser hard-fails on an unknown stamp, so a corrupted model
            // field must never reach the sidecar.
            ("papp:WbScaleVersion",      String(model.wbScaleVersion == 1 ? 1 : 2)),
            ("crs:Exposure2012",         fmtF(model.exposure)),
            ("crs:Contrast2012",         String(format: "%.0f", model.contrast)),
            ("crs:Highlights2012",       String(format: "%.0f", model.highlights)),
            ("crs:Shadows2012",          String(format: "%.0f", model.shadows)),
            ("crs:Whites2012",           String(format: "%.0f", model.whites)),
            ("crs:Blacks2012",           String(format: "%.0f", model.blacks)),
            ("crs:Vibrance",             String(format: "%.0f", model.vibrance)),
            ("crs:Saturation",           String(format: "%.0f", model.saturation)),
            ("crs:Clarity2012",          String(format: "%.0f", model.clarity)),
            ("crs:Texture",              String(format: "%.0f", model.texture)),
            ("crs:Dehaze",               String(format: "%.0f", model.dehaze)),
            ("crs:Sharpness",            String(format: "%.0f", model.sharpenAmount)),
            ("crs:SharpenRadius",        String(format: "%.1f", model.sharpenRadius)),
            ("crs:SharpenDetail",        String(format: "%.0f", model.sharpenDetail)),
            ("crs:SharpenEdgeMasking",   String(format: "%.0f", model.sharpenMasking)),
            ("papp:CaptureSharpeningAmount", String(format: "%.0f", model.captureSharpeningAmount)),
            // Canonical capture-sharpening write key (#456). Legacy
            // `papp:CaptureSharpeningRadius` is read-only — older sidecars
            // still parse, but new sidecars emit Sigma exclusively.
            ("papp:CaptureSharpeningSigma", String(format: "%.1f", model.captureSharpeningSigma)),
            ("crs:LuminanceSmoothing",   String(format: "%.0f", model.nrLuminance)),
            ("crs:ColorNoiseReduction",  String(format: "%.0f", model.nrColor)),
            ("xmp:Rating",               String(culling.stars)),
        ]
        if culling.flag != .none {
            attrs.append(("xmp:Label", culling.flag == .pick ? "Red" : "Rejected"))
        }
        if let hidden = culling.hidden {  // tri-state: only emit when explicitly touched, never a default
            attrs.append(("papp:Hidden", hidden ? "true" : "false"))
        }
        // Brightness (#1102) — emit only when non-default (0) so sidecars
        // produced before the slider existed remain byte-identical for
        // users who never touch it. Key is `papp:Brightness`, NOT the ACR
        // PV2010 `crs:Brightness` (different semantics — see the parser).
        if model.brightness != 0 {
            attrs.append(("papp:Brightness", String(format: "%.0f", model.brightness)))
        }
        // S5 effects fields (#643) — emit only when non-default so sidecars
        // produced before this PR remain byte-identical for users who never
        // touch the vignette / grain / split-tone tools. Defaults are:
        // vignetteAmount=0, vignetteFeather=50, grainAmount=0, grainSize=25,
        // grainRoughness=50, all split-tone scalars=0.
        if model.vignetteAmount != 0 {
            attrs.append(("crs:PostCropVignetteAmount", String(format: "%.0f", model.vignetteAmount)))
        }
        if model.vignetteFeather != 50 {
            attrs.append(("crs:PostCropVignetteFeather", String(format: "%.0f", model.vignetteFeather)))
        }
        if model.grainAmount != 0 {
            attrs.append(("crs:GrainAmount", String(format: "%.0f", model.grainAmount)))
        }
        if model.grainSize != 25 {
            attrs.append(("crs:GrainSize", String(format: "%.0f", model.grainSize)))
        }
        if model.grainRoughness != 50 {
            attrs.append(("crs:GrainFrequency", String(format: "%.0f", model.grainRoughness)))
        }
        if model.splitToneShadowHue != 0 {
            attrs.append(("crs:SplitToningShadowHue", String(format: "%.0f", model.splitToneShadowHue)))
        }
        if model.splitToneShadowSaturation != 0 {
            attrs.append(("crs:SplitToningShadowSaturation", String(format: "%.0f", model.splitToneShadowSaturation)))
        }
        if model.splitToneHighlightHue != 0 {
            attrs.append(("crs:SplitToningHighlightHue", String(format: "%.0f", model.splitToneHighlightHue)))
        }
        if model.splitToneHighlightSaturation != 0 {
            attrs.append(("crs:SplitToningHighlightSaturation", String(format: "%.0f", model.splitToneHighlightSaturation)))
        }
        if model.splitToneBalance != 0 {
            attrs.append(("crs:SplitToningBalance", String(format: "%.0f", model.splitToneBalance)))
        }
        attrs += XMPSerializer.hslAttrs(model: model)
        if model.highlightRecovery != .chromaticAdaptation {
            attrs.append(("papp:HighlightRecoveryMode", model.highlightRecovery.rawValue))
        }
        // DisplayLookCurve (#371; retired in #443) — the field is a no-op
        // post-#443 but the attribute is still emitted on non-default
        // values so it round-trips with pre-#443 sidecars. Default-valued
        // models omit the attribute, so newly-saved sidecars carry no
        // `papp:Look` at all.
        if model.look != .default {
            attrs.append(("papp:Look", model.look.rawValue))
        }
        // Auto Profile Phase 1 (#536) — canonical render-shaping profile.
        // Mirrors raw-core's `serialize`: emit only on non-default
        // (`.auto`). Newly-written sidecars carry `papp:Profile` only;
        // older sidecars without it pick up `.auto` automatically, and
        // legacy `papp:Look` migrates into Profile on read.
        if model.profile != .auto {
            attrs.append(("papp:Profile", model.profile.rawValue))
        }
        // Decode-time chroma pre-filter (#1104) — emit only when
        // non-default (0) so sidecars produced before the field existed
        // remain byte-identical for users who never touch it.
        if model.chromaPrefilter != 0 {
            attrs.append(("papp:ChromaPrefilter", String(format: "%.0f", model.chromaPrefilter)))
        }
        // Hot/dead-pixel suppression (#1106) — emit only when non-default
        // (`.off`), same convention.
        if model.hotPixelSuppression != .off {
            attrs.append(("papp:HotPixelSuppression", model.hotPixelSuppression.rawValue))
        }
        // BM3D deep denoise (#1105) — emit only when non-default (0).
        if model.deepDenoise != 0 {
            attrs.append(("papp:DeepDenoise", String(format: "%.0f", model.deepDenoise)))
        }
        // Crop / straighten (#277, spec § 01 invariant 3) — emit only when
        // non-identity. CropAngle is independent so a pure straighten emits
        // only the angle without the HasCrop/rect group.
        if !model.crop.isIdentity {
            let c = model.crop
            let rectIsIdentity = c.top == 0 && c.left == 0 && c.bottom == 1 && c.right == 1
            if !rectIsIdentity {
                attrs.append(("crs:HasCrop", "True"))
                attrs.append(("crs:CropTop",    fmtCrop(c.top)))
                attrs.append(("crs:CropLeft",   fmtCrop(c.left)))
                attrs.append(("crs:CropBottom", fmtCrop(c.bottom)))
                attrs.append(("crs:CropRight",  fmtCrop(c.right)))
                attrs.append(("crs:CropConstrainToWarp", "0"))
            }
            if c.angle != 0 {
                attrs.append(("crs:CropAngle", fmtCrop(c.angle)))
            }
        }
        return attrs
    }
}
