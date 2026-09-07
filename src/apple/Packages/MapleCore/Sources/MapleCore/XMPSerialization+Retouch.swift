// XMPSerialization+Retouch.swift — nested-element XMP I/O for clone / heal
// repair spots (#3409): Adobe's `crs:RetouchAreas` container, an `rdf:Seq`
// of `rdf:li` → `rdf:Description` corrections naming the spot type and the
// source point, each carrying one nested `crs:Masks` circular leaf for the
// destination disc:
//
//   <crs:RetouchAreas>
//     <rdf:Seq>
//       <rdf:li>
//         <rdf:Description crs:SpotType="heal" … crs:SourceX="0.75">
//           <crs:Masks>
//             <rdf:Seq>
//               <rdf:li crs:What="Mask/CircularGradient" crs:X="0.25" …/>
//             </rdf:Seq>
//           </crs:Masks>
//         </rdf:Description>
//       </rdf:li>
//     </rdf:Seq>
//   </crs:RetouchAreas>
//
// `docs/xmp-canonical-format.md` § "Repair spots" is the contract and
// `raw-core/src/xmp/retouch/` the reference implementation this mirrors
// byte-for-byte on the write side and semantically on the read side. The
// walker is the same explicit state machine `LocalAdjustmentWalker` is.
//
// Read-side tolerance matches every other field this parser reads: a
// correction whose `crs:SpotType` this build does not model, or whose mask
// leaf is not the circular form (a Lightroom brush stroke), is DROPPED and
// the rest of the document still loads. The legacy `crs:RetouchInfo` string
// form older Lightroom versions wrote is read and never written; when a
// document carries both, the struct form wins.

import Foundation

// MARK: - Wire format

/// Shared wire-format constants and codecs for the retouch container.
enum RetouchXMP {
    static let areasContainer = "crs:RetouchAreas"
    static let legacyContainer = "crs:RetouchInfo"
    static let masksElement = "crs:Masks"
    static let maskWhatCircular = "Mask/CircularGradient"

    /// Six-decimal wire precision (`docs/xmp-canonical-format.md` § "Repair
    /// spots"). The two-decimal precision the local-adjustment sliders use
    /// would quantise a spot centre to 1 % of the frame — coarser than the
    /// dust spots this tool exists for. POSIX locale so the wire separator
    /// is "." regardless of the user's region.
    static func fmt6(_ v: Double) -> String {
        String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), v)
    }

    static func clamp01(_ v: Double) -> Double { min(1, max(0, v)) }

    /// The destination disc from a `crs:Masks` leaf, or nil if unmodelled.
    static func parseMaskLeaf(
        _ a: [String: String]
    ) -> (center: RetouchPoint, radius: Double, feather: Double?)? {
        guard a["crs:What"] == maskWhatCircular,
              let radius = LocalAdjustmentXMP.finite(a, "crs:Radius"),
              let x = LocalAdjustmentXMP.finite(a, "crs:X"),
              let y = LocalAdjustmentXMP.finite(a, "crs:Y")
        else { return nil }
        return (RetouchPoint(x: x, y: y), radius, LocalAdjustmentXMP.finite(a, "crs:Feather"))
    }

    /// One legacy `crs:RetouchInfo` `rdf:li` body — a comma-separated
    /// `key = value` list. Tolerant: a missing coordinate, radius or
    /// modelled spot type drops that entry.
    static func parseLegacyInfo(_ body: String) -> RetouchSpot? {
        var fields: [String: String] = [:]
        for field in body.split(separator: ",") {
            let parts = field.split(separator: "=", maxSplits: 1)
            guard parts.count == 2 else { continue }
            fields[parts[0].trimmingCharacters(in: .whitespaces)] =
                parts[1].trimmingCharacters(in: .whitespaces)
        }
        guard let rawKind = fields["spotType"], let kind = RetouchKind.fromWire(rawKind),
              let cx = fields["centerX"].flatMap(Double.init),
              let cy = fields["centerY"].flatMap(Double.init),
              let sx = fields["sourceX"].flatMap(Double.init),
              let sy = fields["sourceY"].flatMap(Double.init),
              let radius = fields["radius"].flatMap(Double.init)
        else { return nil }
        return RetouchSpot(
            kind: kind,
            center: RetouchPoint(x: cx, y: cy),
            source: RetouchPoint(x: sx, y: sy),
            radius: radius,
            feather: RetouchSpot.defaultFeather,
            opacity: 1)
    }
}

// MARK: - Walker

/// A correction whose `rdf:Description` is open but not yet closed.
private struct InProgressSpot {
    var kind: RetouchKind?
    var source: RetouchPoint?
    var offset: RetouchPoint?
    var feather: Double
    var opacity: Double
    var mask: (center: RetouchPoint, radius: Double, feather: Double?)?
}

/// Incremental state for the retouch nested-element walk, driven by
/// `_XMPParserDelegate` exactly like `LocalAdjustmentWalker`.
struct RetouchWalker {
    private enum Container { case areas, legacy }

    private var container: Container?
    private var inContainerSeq = false
    private var inLi = false
    private var current: InProgressSpot?
    private var inMasks = false
    private var inMasksSeq = false
    private var legacyText = ""
    private var areas: [RetouchSpot] = []
    private var legacy: [RetouchSpot] = []

    /// Handle an element opening. Returns true when the element belongs to a
    /// retouch subtree, in which case the caller skips its attribute walk.
    mutating func start(_ qual: String, attributes: [String: String]) -> Bool {
        guard let container else {
            switch qual {
            case RetouchXMP.areasContainer: self.container = .areas
            case RetouchXMP.legacyContainer: self.container = .legacy
            default: return false
            }
            return true
        }
        let isLocal = LocalAdjustmentXMP.isLocalName
        if container == .legacy {
            if !inContainerSeq, isLocal(qual, "Seq") {
                inContainerSeq = true
            } else if inContainerSeq, isLocal(qual, "li") {
                inLi = true
                legacyText = ""
            }
            return true
        }
        if current == nil {
            if !inContainerSeq, isLocal(qual, "Seq") {
                inContainerSeq = true
            } else if inContainerSeq, !inLi, isLocal(qual, "li") {
                inLi = true
            } else if inLi, isLocal(qual, "Description") {
                current = InProgressSpot(
                    kind: attributes["crs:SpotType"].flatMap(RetouchKind.fromWire),
                    source: Self.point(attributes, "crs:SourceX", "crs:SourceY"),
                    offset: Self.point(attributes, "crs:OffsetX", "crs:OffsetY"),
                    feather: LocalAdjustmentXMP.finite(attributes, "crs:Feather")
                        ?? RetouchSpot.defaultFeather,
                    opacity: LocalAdjustmentXMP.finite(attributes, "crs:Opacity") ?? 1,
                    mask: nil)
            }
            return true
        }
        if !inMasks, qual == RetouchXMP.masksElement {
            inMasks = true
        } else if inMasks, !inMasksSeq, isLocal(qual, "Seq") {
            inMasksSeq = true
        } else if inMasksSeq, isLocal(qual, "li"), current?.mask == nil {
            current?.mask = RetouchXMP.parseMaskLeaf(attributes)
        }
        return true
    }

    /// Accumulate text, which only matters inside a legacy `rdf:li`.
    mutating func characters(_ text: String) {
        guard container == .legacy, inLi else { return }
        legacyText += text
    }

    /// Handle an element closing, committing the spot when its
    /// `rdf:Description` ends.
    mutating func end(_ qual: String) {
        guard let container else { return }
        let isLocal = LocalAdjustmentXMP.isLocalName
        if container == .legacy {
            endLegacy(qual, isLocal)
            return
        }
        if inMasksSeq {
            if isLocal(qual, "Seq") { inMasksSeq = false }
            return
        }
        if inMasks {
            if qual == RetouchXMP.masksElement { inMasks = false }
            return
        }
        if let cur = current {
            guard isLocal(qual, "Description") else { return }
            if let spot = Self.assemble(cur) { areas.append(spot) }
            current = nil
            return
        }
        if inLi {
            if isLocal(qual, "li") { inLi = false }
            return
        }
        if inContainerSeq {
            if isLocal(qual, "Seq") { inContainerSeq = false }
            return
        }
        if qual == RetouchXMP.areasContainer { self.container = nil }
    }

    private mutating func endLegacy(_ qual: String, _ isLocal: (String, String) -> Bool) {
        if inLi, isLocal(qual, "li") {
            if let spot = RetouchXMP.parseLegacyInfo(legacyText) { legacy.append(spot) }
            legacyText = ""
            inLi = false
            return
        }
        if inContainerSeq, isLocal(qual, "Seq") {
            inContainerSeq = false
            return
        }
        if qual == RetouchXMP.legacyContainer { container = nil }
    }

    /// Every spot collected. The struct form wins whenever it produced one;
    /// the legacy strings are the fallback for a document with only those.
    func finish() -> [RetouchSpot] { areas.isEmpty ? legacy : areas }

    private static func point(
        _ a: [String: String], _ xKey: String, _ yKey: String
    ) -> RetouchPoint? {
        guard let x = LocalAdjustmentXMP.finite(a, xKey),
              let y = LocalAdjustmentXMP.finite(a, yKey)
        else { return nil }
        return RetouchPoint(x: x, y: y)
    }

    /// Adobe writes the source either absolutely or as a delta from the
    /// destination; both spellings resolve to the same stored point.
    private static func assemble(_ cur: InProgressSpot) -> RetouchSpot? {
        guard let kind = cur.kind, let mask = cur.mask else { return nil }
        let source =
            cur.source
            ?? cur.offset.map {
                RetouchPoint(x: mask.center.x + $0.x, y: mask.center.y + $0.y)
            }
        guard let source else { return nil }
        return RetouchSpot(
            kind: kind,
            center: mask.center,
            source: source,
            radius: mask.radius,
            feather: mask.feather ?? cur.feather,
            opacity: cur.opacity)
    }
}

// MARK: - Serializer

extension XMPSerializer {
    /// Emit the `crs:RetouchAreas` container for `model.retouchSpots`, each
    /// line prefixed so the container sits at `indent`. Byte-identical to
    /// raw-core's `serialize_retouch_areas` and the TypeScript
    /// `retouchAreasBlock` for the same spots — `RetouchXMPTests` pins that
    /// against the shared literal. Returns the empty string when there are
    /// no spots, so an unedited model adds nothing to the document.
    static func _buildRetouchAreasBlock(model: AdjustmentModel, indent: String) -> String {
        guard !model.retouchSpots.isEmpty else { return "" }
        let step = { (n: Int) in indent + String(repeating: " ", count: n) }
        let (i1, i2) = (step(2), step(4))
        let lines =
            ["\(indent)<\(RetouchXMP.areasContainer)>", "\(i1)<rdf:Seq>"]
            + model.retouchSpots.flatMap { _retouchCorrection($0, indent: i2) }
            + ["\(i1)</rdf:Seq>", "\(indent)</\(RetouchXMP.areasContainer)>"]
        return lines.joined(separator: "\n")
    }

    /// One correction. `crs:SourceState` and `crs:Method` are fixed: Maple
    /// always stores the source the user placed and only models the circular
    /// brush, so writing Adobe's own values keeps the document readable by
    /// Lightroom without claiming behaviour Maple does not have.
    private static func _retouchCorrection(_ spot: RetouchSpot, indent: String) -> [String] {
        let step = { (n: Int) in indent + String(repeating: " ", count: n) }
        let (i1, i2, i3, i4) = (step(2), step(4), step(6), step(8))
        let fmt = RetouchXMP.fmt6
        return [
            "\(indent)<rdf:li>",
            "\(i1)<rdf:Description",
            "\(i2)crs:SpotType=\"\(spot.kind.wire)\"",
            "\(i2)crs:SourceState=\"sourceSetExplicitly\"",
            "\(i2)crs:Method=\"circle\"",
            "\(i2)crs:SourceX=\"\(fmt(spot.source.x))\"",
            "\(i2)crs:SourceY=\"\(fmt(spot.source.y))\"",
            "\(i2)crs:Opacity=\"\(fmt(RetouchXMP.clamp01(spot.opacity)))\"",
            "\(i2)crs:Feather=\"\(fmt(RetouchXMP.clamp01(spot.feather)))\"",
            "\(i2)crs:Seed=\"0\">",
            "\(i2)<crs:Masks>",
            "\(i3)<rdf:Seq>",
            "\(i4)<rdf:li",
            "\(i4)  crs:What=\"\(RetouchXMP.maskWhatCircular)\"",
            "\(i4)  crs:MaskValue=\"1\"",
            "\(i4)  crs:X=\"\(fmt(spot.center.x))\"",
            "\(i4)  crs:Y=\"\(fmt(spot.center.y))\"",
            "\(i4)  crs:Radius=\"\(fmt(spot.radius))\"",
            "\(i4)  crs:Flow=\"1\"",
            "\(i4)  crs:CenterWeight=\"0\"/>",
            "\(i3)</rdf:Seq>",
            "\(i2)</crs:Masks>",
            "\(i1)</rdf:Description>",
            "\(indent)</rdf:li>",
        ]
    }
}
