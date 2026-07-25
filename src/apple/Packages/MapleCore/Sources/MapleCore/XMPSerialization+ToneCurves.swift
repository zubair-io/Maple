// XMPSerialization+ToneCurves.swift — nested-element XMP I/O for the four
// point tone curves (#365).
//
// Every other field in the sidecar is a flat attribute on `rdf:Description`,
// which is why `_XMPParserDelegate` only ever looked at `attributeDict` (plus
// the one-off `dc:subject` keyword bag). A point curve is a list, so it takes
// the RDF container form:
//
//   <papp:SceneLinearToneCurve>
//     <rdf:Seq>
//       <rdf:li>0, 0</rdf:li>
//       <rdf:li>128, 140</rdf:li>
//       <rdf:li>255, 255</rdf:li>
//     </rdf:Seq>
//   </papp:SceneLinearToneCurve>
//
// Namespace: Maple's point curves are `papp:`, not Adobe's
// `crs:ToneCurvePV2012*`. The two are different quantities — #273's pipeline
// applies these pre-AgX in scene-linear light, while a PV2012 curve was
// authored against Lightroom's own display transform and only means anything
// after a view transform (`docs/maple-paper.md` § 3). Reading a Lightroom
// curve into these fields would apply a display-referred shape to
// scene-linear data and render it visibly wrong, so the `crs:` keys are
// deliberately not parsed here.
//
// Wire domain: control points are `[0, 1]` on the model and PV2012's
// `[0, 255]` on the wire; the scale is applied at this boundary only, never
// on `ToneCurve` itself. Identity (the empty point list) emits no element at
// all — not an empty `rdf:Seq` — so unedited sidecars stay byte-clean.

import Foundation

// MARK: - Wire format

/// Shared wire-format constants and codecs for the point tone curves.
enum ToneCurveXMP {
    /// The four curve parent elements, in canonical emit order.
    static let elements = [
        "papp:SceneLinearToneCurve",
        "papp:SceneLinearToneCurveRed",
        "papp:SceneLinearToneCurveGreen",
        "papp:SceneLinearToneCurveBlue",
    ]

    /// PV2012's coordinate domain. Kept for familiarity and for
    /// Lightroom-shaped tooling that inspects sidecars by eye.
    static let wireScale = 255.0

    /// True when `qual` is the `rdf:li` element regardless of the bound
    /// prefix — a valid sidecar may bind the RDF namespace to any prefix, and
    /// the Rust and TypeScript walkers match on the local name too.
    static func isListItem(_ qual: String) -> Bool {
        qual == "li" || qual.hasSuffix(":li")
    }

    /// Decode one `<rdf:li>x, y</rdf:li>` body into a `[0, 1]` control point.
    /// Returns nil for anything that is not a finite numeric pair — a
    /// malformed entry is dropped rather than failing the parse, matching how
    /// the walker treats every other unrecognised construct.
    static func parsePoint(_ text: String) -> ToneCurvePoint? {
        let parts = text.split(separator: ",", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let x = Double(parts[0].trimmingCharacters(in: .whitespacesAndNewlines)),
              let y = Double(parts[1].trimmingCharacters(in: .whitespacesAndNewlines)),
              x.isFinite, y.isFinite
        else { return nil }
        return (x: x / wireScale, y: y / wireScale)
    }

    /// Format one `[0, 1]` coordinate back into the wire domain through the
    /// canonical number codec (integers bare, non-integers at two decimals
    /// with trailing zeros trimmed).
    static func formatCoordinate(_ v: Double) -> String {
        XMPSerializer.fmtWb(v * wireScale)
    }
}

// MARK: - Parser walk

/// Incremental state for the nested tone-curve walk driven by
/// `_XMPParserDelegate`.
///
/// Deliberately a small state machine rather than a general nested-schema
/// engine: four known parents, one known container, one known leaf. Anything
/// else in the document is untouched.
struct ToneCurveWalker {
    /// Index into `ToneCurveXMP.elements` of the parent being read.
    private var active: Int?
    private var points: [ToneCurvePoint] = []
    /// Accumulates `rdf:li` text — `XMLParser` may deliver a single leaf's
    /// characters in several chunks.
    private var listItemText: String?

    /// Handle an element opening. Returns true when the element belongs to a
    /// tone-curve subtree, in which case the caller skips its attribute walk
    /// — these elements carry no Maple attributes.
    mutating func start(_ qual: String) -> Bool {
        if let index = ToneCurveXMP.elements.firstIndex(of: qual) {
            active = index
            points = []
            listItemText = nil
            return true
        }
        guard active != nil else { return false }
        if ToneCurveXMP.isListItem(qual) {
            listItemText = ""
        }
        // `rdf:Seq` (or any other wrapper) carries no value of its own.
        return true
    }

    /// Accumulate text content while inside an `rdf:li`.
    mutating func characters(_ chunk: String) {
        guard listItemText != nil else { return }
        listItemText! += chunk
    }

    /// Handle an element closing, committing the finished curve onto `model`
    /// when the parent element ends.
    mutating func end(_ qual: String, into model: inout AdjustmentModel) {
        guard let index = active else { return }
        if ToneCurveXMP.isListItem(qual) {
            if let text = listItemText, let point = ToneCurveXMP.parsePoint(text) {
                points.append(point)
            }
            listItemText = nil
            return
        }
        guard ToneCurveXMP.elements[index] == qual else { return }
        let curve = ToneCurve(points: points)
        switch index {
        case 0: model.toneCurveLuma = curve
        case 1: model.toneCurveRed = curve
        case 2: model.toneCurveGreen = curve
        default: model.toneCurveBlue = curve
        }
        active = nil
        points = []
        listItemText = nil
    }
}

// MARK: - Serializer

extension XMPSerializer {
    /// Emit the nested tone-curve children for `model`, each line prefixed so
    /// the parent element sits at `indent`.
    ///
    /// `indent` is a parameter because the three writers nest
    /// `rdf:Description`'s children at different depths today; the block's
    /// internal shape is identical everywhere, which is what the
    /// cross-language parity tests pin.
    ///
    /// Returns the empty string when all four curves are identity, so an
    /// unedited model adds nothing to the document.
    static func _buildToneCurvesBlock(model: AdjustmentModel, indent: String) -> String {
        let curves = [
            model.toneCurveLuma, model.toneCurveRed, model.toneCurveGreen, model.toneCurveBlue,
        ]
        let blocks = zip(ToneCurveXMP.elements, curves).compactMap {
            (element, curve) -> String? in
            guard !curve.isIdentity else { return nil }
            let items = curve.points.map { point in
                let x = ToneCurveXMP.formatCoordinate(point.x)
                let y = ToneCurveXMP.formatCoordinate(point.y)
                return "\(indent)    <rdf:li>\(x), \(y)</rdf:li>"
            }
            return ([
                "\(indent)<\(element)>",
                "\(indent)  <rdf:Seq>",
            ] + items + [
                "\(indent)  </rdf:Seq>",
                "\(indent)</\(element)>",
            ]).joined(separator: "\n")
        }
        return blocks.joined(separator: "\n")
    }
}
