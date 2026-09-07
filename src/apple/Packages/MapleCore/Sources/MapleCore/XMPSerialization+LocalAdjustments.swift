// XMPSerialization+LocalAdjustments.swift — nested-element XMP I/O for
// local adjustments (#358): the canonical Adobe Camera Raw
// `crs:GradientBasedCorrections` (linear masks) /
// `crs:CircularGradientBasedCorrections` (radial masks) containers, each an
// `rdf:Seq` of `rdf:li` → `rdf:Description` corrections carrying the
// `crs:Local*2012` sliders and one nested `crs:CorrectionMasks` mask leaf:
//
//   <crs:GradientBasedCorrections>
//     <rdf:Seq>
//       <rdf:li>
//         <rdf:Description crs:What="Correction" … crs:LocalExposure2012="0.5">
//           <crs:CorrectionMasks>
//             <rdf:Seq>
//               <rdf:li crs:What="Mask/Gradient" crs:ZeroX="0.2" …/>
//             </rdf:Seq>
//           </crs:CorrectionMasks>
//         </rdf:Description>
//       </rdf:li>
//     </rdf:Seq>
//   </crs:GradientBasedCorrections>
//
// `docs/xmp-canonical-format.md` § "Local adjustments" is the contract and
// `raw-core/src/xmp/local_adjustments/` the reference implementation this
// mirrors byte-for-byte on the write side and semantically on the read
// side. The walker below is the same explicit state machine raw-core's
// `LocalAdjustmentsWalker` is — the schema is one fixed shape six levels
// deep, not an arbitrary tree — driven by `_XMPParserDelegate` exactly like
// `ToneCurveWalker`.
//
// Read-side tolerance matches every other field this parser reads rather
// than raw-core's hard-error posture: a correction whose mask isn't a shape
// Maple models, that is inactive (`CorrectionActive="False"`), or whose
// required geometry is missing or non-numeric is DROPPED — never silently
// placed at an invented `0`/`1` — and the rest of the document still loads.
// A corrupt slider value on an otherwise valid correction reads as "not
// set", the same rule `applyAttribute` applies to the flat sliders.

import Foundation

// MARK: - Wire format

/// Shared wire-format constants and codecs for the local-adjustment containers.
enum LocalAdjustmentXMP {
    enum Kind {
        case linear, radial, group
    }

    static let linearContainer = "crs:GradientBasedCorrections"
    static let radialContainer = "crs:CircularGradientBasedCorrections"
    /// Bitmap and Everywhere masks (#3271) — Lightroom 11+'s own container
    /// for its AI masks, so a reader that doesn't understand
    /// `papp:MaskSource` still sees a structurally valid correction.
    static let groupContainer = "crs:MaskGroupBasedCorrections"
    /// All three containers, in canonical emit order.
    static let containers = [linearContainer, radialContainer, groupContainer]
    static let masksElement = "crs:CorrectionMasks"

    static func containerKind(_ qual: String) -> Kind? {
        switch qual {
        case linearContainer: return .linear
        case radialContainer: return .radial
        case groupContainer: return .group
        default: return nil
        }
    }

    static func maskWhat(_ kind: Kind) -> String {
        switch kind {
        case .linear: return "Mask/Gradient"
        case .radial: return "Mask/CircularGradient"
        case .group: return "Mask/Image"
        }
    }

    /// Slider attribute ↔ model field, in canonical emit order. Every field
    /// has a direct Adobe key except `vibrance`: Adobe's local-correction
    /// struct has no vibrance control, so it rides Maple's own
    /// `papp:LocalVibrance`.
    static let sliders: [(key: String, get: (PartialAdjustments) -> Double?,
                          set: (inout PartialAdjustments, Double) -> Void)] = [
        ("crs:LocalExposure2012", { $0.exposure }, { $0.exposure = $1 }),
        ("crs:LocalContrast2012", { $0.contrast }, { $0.contrast = $1 }),
        ("crs:LocalHighlights2012", { $0.highlights }, { $0.highlights = $1 }),
        ("crs:LocalShadows2012", { $0.shadows }, { $0.shadows = $1 }),
        ("crs:LocalWhites2012", { $0.whites }, { $0.whites = $1 }),
        ("crs:LocalBlacks2012", { $0.blacks }, { $0.blacks = $1 }),
        ("crs:LocalSaturation", { $0.saturation }, { $0.saturation = $1 }),
        ("papp:LocalVibrance", { $0.vibrance }, { $0.vibrance = $1 }),
        ("crs:LocalTemperature", { $0.temperature }, { $0.temperature = $1 }),
        ("crs:LocalTint", { $0.tint }, { $0.tint = $1 }),
        // Hue (#3269): Maple's slider is ±100, Adobe's `crs:LocalHue` is
        // ±1 — scaled at the wire boundary, matching raw-core's serializer
        // (`v / 100`) and parser (`v * 100`). `parseAdjustments`' Amount
        // dial then applies to the wire value exactly as it does for every
        // other slider, so the products agree across platforms.
        ("crs:LocalHue", { $0.hue.map { $0 / 100 } }, { $0.hue = $1 * 100 }),
    ]

    /// Four-decimal variant of `fmtNum`, trailing zeros trimmed — only for
    /// `crs:LocalHue` (see the emitter). `-0.425` stays `-0.425`; `-0.2`
    /// stays `-0.2`.
    static func fmtNum4(_ v: Double) -> String {
        // Explicit POSIX locale: the wire format is "." regardless of the
        // user's region (#3347 review).
        let posix = Locale(identifier: "en_US_POSIX")
        let rounded = (v * 10_000).rounded() / 10_000
        if rounded == rounded.rounded() { return String(format: "%.0f", locale: posix, rounded) }
        var text = String(format: "%.4f", locale: posix, rounded)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }

    /// The colour-range refinement's `papp:Range*` attributes (#3270), which
    /// sit on the correction's own `rdf:Description` alongside the sliders.
    /// Maple-private by design — Adobe has no range-mask schema to borrow —
    /// so a foreign reader simply ignores them.
    static func parseRange(_ a: [String: String]) -> RangeRefinement? {
        guard a["papp:RangeKind"] == "Color",
              let hue = finite(a, "papp:RangeHue"),
              let width = finite(a, "papp:RangeHueWidth"),
              let chromaMin = finite(a, "papp:RangeChromaMin"),
              let lMin = finite(a, "papp:RangeLMin"),
              let lMax = finite(a, "papp:RangeLMax"),
              let feather = finite(a, "papp:RangeFeather")
        else { return nil }
        return .color(
            hueDeg: hue, hueHalfWidthDeg: width, chromaMin: chromaMin,
            lMin: lMin, lMax: lMax, feather: feather)
    }

    /// RDF structural elements match on local name regardless of the bound
    /// prefix — same rule as `ToneCurveXMP.isListItem`.
    static func isLocalName(_ qual: String, _ local: String) -> Bool {
        qual == local || qual.hasSuffix(":" + local)
    }

    /// A finite numeric attribute, or nil when absent or unparseable.
    static func finite(_ attributes: [String: String], _ key: String) -> Double? {
        guard let raw = attributes[key], let value = Double(raw.trimmingCharacters(in: .whitespaces)),
              value.isFinite
        else { return nil }
        return value
    }

    /// Adobe's boolean spellings, case-insensitive; nil for anything else.
    static func bool(_ raw: String?) -> Bool? {
        switch raw?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "1", "true", "on": return true
        case "0", "false", "off": return false
        default: return nil
        }
    }

    static func degreesToRadians(_ degrees: Double) -> Double { degrees * Double.pi / 180 }
    static func radiansToDegrees(_ radians: Double) -> Double { radians * 180 / Double.pi }

    /// Parse one `crs:CorrectionMasks` leaf. Nil when the leaf isn't the
    /// shape this container models or its required geometry is missing.
    static func parseMask(_ kind: Kind, _ a: [String: String]) -> LocalMask? {
        guard a["crs:What"] == maskWhat(kind) else { return nil }
        switch kind {
        case .linear:
            guard let zx = finite(a, "crs:ZeroX"), let zy = finite(a, "crs:ZeroY"),
                  let fx = finite(a, "crs:FullX"), let fy = finite(a, "crs:FullY")
            else { return nil }
            return .linear(
                start: MaskPoint(x: zx, y: zy), end: MaskPoint(x: fx, y: fy),
                feather: finite(a, "papp:LocalFeather") ?? 0.5)
        case .radial:
            guard let top = finite(a, "crs:Top"), let left = finite(a, "crs:Left"),
                  let bottom = finite(a, "crs:Bottom"), let right = finite(a, "crs:Right")
            else { return nil }
            let featherPct = finite(a, "crs:Feather") ?? 50
            return .radial(
                center: MaskPoint(x: (left + right) / 2, y: (top + bottom) / 2),
                radii: MaskPoint(x: (right - left) / 2, y: (bottom - top) / 2),
                angle: degreesToRadians(finite(a, "crs:Angle") ?? 0),
                feather: min(1, max(0, featherPct / 100)),
                invert: bool(a["crs:Flipped"]) ?? false)
        case .group:
            // `papp:MaskSource` is what separates Maple's two group-container
            // masks from a Lightroom AI mask sharing `Mask/Image` — anything
            // else here stays unrecognized, and the correction is dropped
            // rather than silently rendered as something it isn't.
            switch a["papp:MaskSource"] {
            case "PersonSkin":
                guard let digest = a["papp:MaskDigest"], !digest.isEmpty else { return nil }
                let recipe = BitmapRecipe(
                    person: Int(a["papp:MaskPerson"] ?? "") ?? 0,
                    facialSkin: bool(a["papp:MaskFacialSkin"]) ?? true,
                    bodySkin: bool(a["papp:MaskBodySkin"]) ?? true,
                    model: a["papp:MaskModel"] ?? "",
                    digest: digest)
                // The raster itself is a cache derivative keyed by `digest`,
                // never sidecar state, so the live registry id starts unset
                // and is resolved after load (see #3294).
                return .bitmap(recipe: recipe, rasterId: 0)
            case "Everywhere":
                return .everywhere
            default:
                return nil
            }
        }
    }

    /// Parse a correction `rdf:Description`'s sliders, with Adobe's 0–1
    /// `CorrectionAmount` dial already applied to each stored value — the
    /// same effect Adobe's own Amount slider has.
    static func parseAdjustments(_ a: [String: String]) -> PartialAdjustments {
        let amount = finite(a, "crs:CorrectionAmount") ?? 1
        return sliders.reduce(into: PartialAdjustments()) { acc, slider in
            guard let value = finite(a, slider.key) else { return }
            slider.set(&acc, amount == 1 ? value : value * amount)
        }
    }
}

// MARK: - Parser walk

/// Incremental state for the local-adjustments walk driven by
/// `_XMPParserDelegate`. Explicit fields rather than a generic stack, like
/// raw-core's `LocalAdjustmentsWalker`.
struct LocalAdjustmentWalker {
    private struct InProgress {
        var adjustments: PartialAdjustments
        var range: RangeRefinement?
        var active: Bool
        /// Set once a mask leaf this container models has been seen —
        /// first recognized leaf wins.
        var mask: LocalMask?
    }

    private var container: LocalAdjustmentXMP.Kind?
    private var inContainerSeq = false
    private var inLayerLi = false
    private var current: InProgress?
    private var inMasks = false
    private var inMasksSeq = false
    private var finished: [LocalAdjustment] = []

    /// Handle an element opening. Returns true when the element belongs to a
    /// local-adjustments subtree, in which case the caller skips its
    /// attribute walk — nothing inside a container is a flat Maple field.
    mutating func start(_ qual: String, attributes: [String: String]) -> Bool {
        guard let kind = container else {
            container = LocalAdjustmentXMP.containerKind(qual)
            return container != nil
        }
        let isLocal = LocalAdjustmentXMP.isLocalName
        if current == nil {
            if !inContainerSeq, isLocal(qual, "Seq") {
                inContainerSeq = true
            } else if inContainerSeq, !inLayerLi, isLocal(qual, "li") {
                inLayerLi = true
            } else if inLayerLi, isLocal(qual, "Description") {
                current = InProgress(
                    adjustments: LocalAdjustmentXMP.parseAdjustments(attributes),
                    range: LocalAdjustmentXMP.parseRange(attributes),
                    active: LocalAdjustmentXMP.bool(attributes["crs:CorrectionActive"]) ?? true,
                    mask: nil)
            }
            // Anything else inside the container is swallowed, not modeled.
            return true
        }
        if !inMasks, qual == LocalAdjustmentXMP.masksElement {
            inMasks = true
        } else if inMasks, !inMasksSeq, isLocal(qual, "Seq") {
            inMasksSeq = true
        } else if inMasksSeq, isLocal(qual, "li"), current?.mask == nil {
            // `XMLParser` reports a self-closing `<rdf:li …/>` and an explicit
            // `<rdf:li …></rdf:li>` pair identically, so both shapes land here.
            current?.mask = LocalAdjustmentXMP.parseMask(kind, attributes)
        }
        return true
    }

    /// Handle an element closing, committing the correction when its
    /// `rdf:Description` ends: active and with a recognized mask ⇒ a layer;
    /// inactive (disabled pin) or maskless ⇒ dropped.
    mutating func end(_ qual: String) {
        guard container != nil else { return }
        let isLocal = LocalAdjustmentXMP.isLocalName
        if inMasksSeq {
            if isLocal(qual, "Seq") { inMasksSeq = false }
            return
        }
        if inMasks {
            if qual == LocalAdjustmentXMP.masksElement { inMasks = false }
            return
        }
        if let cur = current {
            guard isLocal(qual, "Description") else { return }
            if cur.active, let mask = cur.mask {
                finished.append(
                    LocalAdjustment(mask: mask, range: cur.range, adjustments: cur.adjustments))
            }
            current = nil
            return
        }
        if inLayerLi {
            if isLocal(qual, "li") { inLayerLi = false }
            return
        }
        if inContainerSeq {
            if isLocal(qual, "Seq") { inContainerSeq = false }
            return
        }
        if LocalAdjustmentXMP.containerKind(qual) != nil { container = nil }
    }

    /// Every layer collected across both containers, in document order.
    func finish() -> [LocalAdjustment] { finished }
}

// MARK: - Serializer

extension XMPSerializer {
    /// Emit the canonical container blocks for `model.localAdjustments`,
    /// each line prefixed so the container sits at `indent`. Byte-identical
    /// to raw-core's `serialize_local_adjustments` and the TypeScript
    /// `localAdjustmentBlocks` for the same layers — `LocalAdjustmentXMPTests`
    /// pins that against the shared literal.
    ///
    /// Adobe keeps linear and radial corrections in two separate arrays, so
    /// an interleaved model stack round-trips as two contiguous runs (all
    /// linear, then all radial). Returns the empty string when there are no
    /// layers, so an unedited model adds nothing to the document.
    static func _buildLocalAdjustmentsBlock(model: AdjustmentModel, indent: String) -> String {
        let kinds: [(tag: String, isKind: (LocalMask) -> Bool)] = [
            (LocalAdjustmentXMP.linearContainer, { if case .linear = $0 { return true }; return false }),
            (LocalAdjustmentXMP.radialContainer, { if case .radial = $0 { return true }; return false }),
            (LocalAdjustmentXMP.groupContainer, {
                switch $0 {
                case .bitmap, .everywhere: return true
                case .linear, .radial: return false
                }
            }),
        ]
        return kinds.compactMap { kind -> String? in
            let layers = model.localAdjustments.filter { kind.isKind($0.mask) }
            return layers.isEmpty ? nil : _localAdjustmentContainer(kind.tag, layers, indent: indent)
        }
        .joined(separator: "\n")
    }

    private static func _localAdjustmentContainer(
        _ tag: String, _ layers: [LocalAdjustment], indent: String
    ) -> String {
        let step = { (n: Int) in indent + String(repeating: " ", count: n) }
        let (i1, i2, i3, i4, i5, i6) = (step(2), step(4), step(6), step(8), step(10), step(12))
        let layerLines = layers.flatMap { layer -> [String] in
            let attrs = [
                "\(i4)crs:What=\"Correction\"",
                "\(i4)crs:CorrectionAmount=\"1\"",
                "\(i4)crs:CorrectionActive=\"True\"",
            ] + LocalAdjustmentXMP.sliders.compactMap { slider -> String? in
                // Only fields actually set are written; a non-finite value is
                // not representable in XMP and is skipped like every slider.
                guard let value = slider.get(layer.adjustments), value.isFinite else { return nil }
                // LocalHue rides Adobe's ±1 scale: the canonical 2-decimal
                // precision would quantise Maple's ±100 slider to whole units,
                // so it gets four (#3280 review) — mirrors raw-core's `fmt4`.
                let text = slider.key == "crs:LocalHue" ? LocalAdjustmentXMP.fmtNum4(value) : fmtNum(value)
                return "\(i4)\(slider.key)=\"\(text)\""
            } + _localAdjustmentRangeLines(layer.range, indent: i4)
            return [
                "\(i2)<rdf:li>",
                "\(i3)<rdf:Description",
                attrs.joined(separator: "\n") + ">",
                "\(i4)<crs:CorrectionMasks>",
                "\(i5)<rdf:Seq>",
            ] + _localAdjustmentMaskLines(layer.mask, indent: i6) + [
                "\(i5)</rdf:Seq>",
                "\(i4)</crs:CorrectionMasks>",
                "\(i3)</rdf:Description>",
                "\(i2)</rdf:li>",
            ]
        }
        return (["\(indent)<\(tag)>", "\(i1)<rdf:Seq>"] + layerLines
            + ["\(i1)</rdf:Seq>", "\(indent)</\(tag)>"]).joined(separator: "\n")
    }

    /// `papp:Range*` attributes for a colour-range refinement (#3270), in
    /// the same order raw-core's `serialize_range` emits them. Empty when
    /// the layer has no refinement, so an unrefined mask is byte-identical
    /// to the pre-#3270 output.
    private static func _localAdjustmentRangeLines(
        _ range: RangeRefinement?, indent: String
    ) -> [String] {
        guard case .color(let hue, let width, let chromaMin, let lMin, let lMax, let feather) = range
        else { return [] }
        return [
            "\(indent)papp:RangeKind=\"Color\"",
            "\(indent)papp:RangeHue=\"\(fmtNum(hue))\"",
            "\(indent)papp:RangeHueWidth=\"\(fmtNum(width))\"",
            "\(indent)papp:RangeChromaMin=\"\(fmtNum(chromaMin))\"",
            "\(indent)papp:RangeLMin=\"\(fmtNum(lMin))\"",
            "\(indent)papp:RangeLMax=\"\(fmtNum(lMax))\"",
            "\(indent)papp:RangeFeather=\"\(fmtNum(feather))\"",
        ]
    }

    private static func _localAdjustmentMaskLines(_ mask: LocalMask, indent: String) -> [String] {
        switch mask {
        case .linear(let start, let end, let feather):
            return [
                "\(indent)<rdf:li",
                "\(indent)  crs:What=\"\(LocalAdjustmentXMP.maskWhat(.linear))\"",
                "\(indent)  crs:MaskValue=\"1\"",
                "\(indent)  crs:ZeroX=\"\(fmtNum(start.x))\" crs:ZeroY=\"\(fmtNum(start.y))\"",
                "\(indent)  crs:FullX=\"\(fmtNum(end.x))\" crs:FullY=\"\(fmtNum(end.y))\"",
                "\(indent)  papp:LocalFeather=\"\(fmtNum(feather))\"/>",
            ]
        case .radial(let center, let radii, let angle, let feather, let invert):
            let (top, left) = (fmtNum(center.y - radii.y), fmtNum(center.x - radii.x))
            let (bottom, right) = (fmtNum(center.y + radii.y), fmtNum(center.x + radii.x))
            let degrees = fmtNum(LocalAdjustmentXMP.radiansToDegrees(angle))
            return [
                "\(indent)<rdf:li",
                "\(indent)  crs:What=\"\(LocalAdjustmentXMP.maskWhat(.radial))\"",
                "\(indent)  crs:MaskValue=\"1\"",
                "\(indent)  crs:Top=\"\(top)\" crs:Left=\"\(left)\" crs:Bottom=\"\(bottom)\" crs:Right=\"\(right)\"",
                "\(indent)  crs:Angle=\"\(degrees)\" crs:Midpoint=\"50\" crs:Roundness=\"0\"",
                "\(indent)  crs:Feather=\"\(fmtNum(feather * 100))\" crs:Flipped=\"\(invert ? "True" : "False")\"/>",
            ]
        case .bitmap(let recipe, _):
            // `rasterId` is deliberately NOT written: the raster is a cache
            // derivative resolved from `papp:MaskDigest` at load time, so a
            // sidecar stays portable between machines.
            return [
                "\(indent)<rdf:li",
                "\(indent)  crs:What=\"\(LocalAdjustmentXMP.maskWhat(.group))\"",
                "\(indent)  crs:MaskSubType=\"1\"",
                "\(indent)  crs:MaskValue=\"1\"",
                "\(indent)  papp:MaskSource=\"PersonSkin\"",
                "\(indent)  papp:MaskPerson=\"\(recipe.person)\"",
                "\(indent)  papp:MaskFacialSkin=\"\(recipe.facialSkin ? "True" : "False")\"",
                "\(indent)  papp:MaskBodySkin=\"\(recipe.bodySkin ? "True" : "False")\"",
                "\(indent)  papp:MaskModel=\"\(escapeXMLAttr(recipe.model))\"",
                "\(indent)  papp:MaskDigest=\"\(escapeXMLAttr(recipe.digest))\"/>",
            ]
        case .everywhere:
            return [
                "\(indent)<rdf:li",
                "\(indent)  crs:What=\"\(LocalAdjustmentXMP.maskWhat(.group))\"",
                "\(indent)  crs:MaskValue=\"1\"",
                "\(indent)  papp:MaskSource=\"Everywhere\"/>",
            ]
        }
    }
}
