// XMPSerialization+LocalAdjustments.swift — nested-element XMP I/O for
// local adjustments (#358, brush by #360): the canonical Adobe Camera Raw
// `crs:GradientBasedCorrections` (linear masks) /
// `crs:CircularGradientBasedCorrections` (radial masks) containers plus
// Maple's own `papp:BrushCorrections` (brush masks), each an
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
    case linear, radial, brush, group
  }

  static let linearContainer = "crs:GradientBasedCorrections"
  static let radialContainer = "crs:CircularGradientBasedCorrections"
  /// Brush masks (#360) — Maple's own container. Lightroom's
  /// `crs:PaintBasedCorrections` is never modelled: its dab shape cannot be
  /// re-emitted from this model, so it stays verbatim passthrough.
  static let brushContainer = "papp:BrushCorrections"
  /// Bitmap and Everywhere masks (#3271) — Lightroom 11+'s own container
  /// for its AI masks, so a reader that doesn't understand
  /// `papp:MaskSource` still sees a structurally valid correction.
  static let groupContainer = "crs:MaskGroupBasedCorrections"
  /// All four containers, in canonical emit order.
  static let containers = [linearContainer, radialContainer, brushContainer, groupContainer]
  static let masksElement = "crs:CorrectionMasks"

  static func containerKind(_ qual: String) -> Kind? {
    switch qual {
    case linearContainer: return .linear
    case radialContainer: return .radial
    case brushContainer: return .brush
    case groupContainer: return .group
    default: return nil
    }
  }

  static func maskWhat(_ kind: Kind) -> String {
    switch kind {
    case .linear: return "Mask/Gradient"
    case .radial: return "Mask/CircularGradient"
    case .brush: return "Mask/Paint"
    case .group: return "Mask/Image"
    }
  }

  /// Slider attribute ↔ model field, in canonical emit order. Every field
  /// has a direct Adobe key except `vibrance`: Adobe's local-correction
  /// struct has no vibrance control, so it rides Maple's own
  /// `papp:LocalVibrance`.
  static let sliders:
    [(
      key: String, get: (PartialAdjustments) -> Double?,
      set: (inout PartialAdjustments, Double) -> Void
    )] = [
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
      // Hue (#3269) and the six spatial controls (#3407): Maple's sliders
      // are ±100 (0…100 for noise and defringe), Adobe's keys are the ±1
      // fraction Lightroom writes — scaled at the wire boundary, matching
      // raw-core's serializer (`v / 100`) and parser (`v * 100`).
      // `parseAdjustments`' Amount dial then applies to the wire value
      // exactly as it does for every other slider, so the products agree
      // across platforms. Emission order matches raw-core's own second
      // loop: hue first, then the six.
      ("crs:LocalHue", { $0.hue.map { $0 / 100 } }, { $0.hue = $1 * 100 }),
      ("crs:LocalTexture", { $0.texture.map { $0 / 100 } }, { $0.texture = $1 * 100 }),
      ("crs:LocalClarity2012", { $0.clarity.map { $0 / 100 } }, { $0.clarity = $1 * 100 }),
      ("crs:LocalDehaze", { $0.dehaze.map { $0 / 100 } }, { $0.dehaze = $1 * 100 }),
      ("crs:LocalSharpness", { $0.sharpness.map { $0 / 100 } }, { $0.sharpness = $1 * 100 }),
      (
        "crs:LocalLuminanceNoise", { $0.luminanceNoise.map { $0 / 100 } },
        { $0.luminanceNoise = $1 * 100 }
      ),
      ("crs:LocalDefringe", { $0.defringe.map { $0 / 100 } }, { $0.defringe = $1 * 100 }),
    ]

  /// The keys whose wire value is Adobe's ±1 fraction rather than Maple's
  /// ±100 slider — they get `fmtNum4` instead of the canonical two
  /// decimals, since two would quantise the slider to whole units. Mirror
  /// of raw-core's second `serialize_adjustments` loop (`fmt4`).
  static let fractionScaledKeys: Set<String> = [
    "crs:LocalHue", "crs:LocalTexture", "crs:LocalClarity2012", "crs:LocalDehaze",
    "crs:LocalSharpness", "crs:LocalLuminanceNoise", "crs:LocalDefringe",
  ]

  /// Four-decimal variant of `fmtNum`, trailing zeros trimmed — for the
  /// `fractionScaledKeys` (see the emitter). `-0.425` stays `-0.425`;
  /// `-0.2` stays `-0.2`.
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
      let version = finite(a, "crs:Version") ?? 1
      guard version == 1 || version == 2 else { return nil }
      let modern = version == 2
      return .radial(
        center: MaskPoint(x: (left + right) / 2, y: (top + bottom) / 2),
        radii: MaskPoint(x: (right - left) / 2, y: (bottom - top) / 2),
        angle: degreesToRadians(finite(a, "crs:Angle") ?? 0),
        feather: min(1, max(0, featherPct / (modern ? 50 : 100))),
        invert: (bool(a["crs:Flipped"]) ?? false) != modern)
    case .brush:
      // An unknown `papp:BrushVersion` or a malformed series drops the
      // correction; a missing `papp:Dabs` is an empty stroke.
      guard a["papp:BrushVersion"] == String(LocalMaskWire.brushVersion),
        let dabs = parseDabSeries(a["papp:Dabs"])
      else { return nil }
      return .brush(dabs: dabs, digest: a["papp:BrushDigest"] ?? "", rasterId: 0)
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
    var attributes: [String: String]
    var adjustments: PartialAdjustments
    var range: RangeRefinement?
    var active: Bool
    var mask: LocalMask?
    var components: [MaskComponent] = []
    var invalidGroup = false
  }
  private var container: LocalAdjustmentXMP.Kind?
  private var depth = 0
  private var inMasks = false
  private var inMasksSeq = false
  private var current: InProgress?
  private var finished: [KeyedLocalAdjustment] = []
  private var containerStart = 0
  private var containerDropped = false
  private var brushContainers = 0
  /// Ordinals of the brush containers kept verbatim, whose keys the caller
  /// reads by namespace (#4427).
  private(set) var droppedBrushContainers: [Int] = []

  mutating func start(_ qual: String, attributes: [String: String]) -> Bool {
    guard let kind = container else {
      container = LocalAdjustmentXMP.containerKind(qual)
      if container != nil { depth = 1 }
      containerStart = finished.count
      containerDropped = false
      return container != nil
    }
    depth += 1
    let isLocal = LocalAdjustmentXMP.isLocalName
    if depth == 4, isLocal(qual, "Description") {
      current = InProgress(
        attributes: attributes,
        adjustments: LocalAdjustmentXMP.parseAdjustments(attributes),
        range: LocalAdjustmentXMP.parseRange(attributes),
        active: LocalAdjustmentXMP.bool(attributes["crs:CorrectionActive"]) ?? true,
        mask: nil)
    } else if depth == 5, qual == LocalAdjustmentXMP.masksElement {
      inMasks = true
    } else if depth == 6, inMasks, isLocal(qual, "Seq") {
      inMasksSeq = true
    } else if depth == 7, inMasksSeq {
      if kind == .group {
        if isLocal(qual, "li"), let component = LocalAdjustmentXMP.parseComponent(attributes) {
          current?.components.append(component)
        } else {
          current?.invalidGroup = true
        }
      } else if isLocal(qual, "li"), current?.mask == nil {
        current?.mask = LocalAdjustmentXMP.parseMask(kind, attributes)
      }
    }
    return true
  }

  mutating func end(_ qual: String) {
    guard let kind = container else { return }
    if depth == 6 { inMasksSeq = false }
    if depth == 5 { inMasks = false }
    if depth == 4, let cur = current {
      let mask =
        kind == .group
        ? (cur.invalidGroup
          ? nil : LocalAdjustmentXMP.parseGroup(cur.attributes, components: cur.components))
        : cur.mask
      if cur.active, let mask {
        finished.append(
          (
            LocalAdjustment(
              mask: mask, range: cur.range, adjustments: cur.adjustments,
              xmpMetadata: kind == .group
                ? LocalAdjustmentXMP.metadata(
                  cur.attributes, owned: LocalAdjustmentXMP.correctionKeys) : nil),
            LocalAdjustmentOrder.parseKey(cur.attributes)
          ))
      } else {
        containerDropped = true
      }
      current = nil
    }
    if depth == 1 {
      // Brush is all-or-nothing: the passthrough keeps a partly unreadable
      // container verbatim (`isModeledBrushContainer`).
      if kind == .brush, containerDropped {
        finished.removeSubrange(containerStart...)
        droppedBrushContainers.append(brushContainers)
      }
      if kind == .brush { brushContainers += 1 }
      container = nil
    }
    depth -= 1
  }

  /// Layers in document order, each with its `papp:LayerOrder` key; the
  /// caller restores model order after merging in the group layers.
  func finish() -> [KeyedLocalAdjustment] { finished }
}

// MARK: - Serializer

extension XMPSerializer {
  /// Emit the canonical container blocks for `model.localAdjustments`,
  /// each line prefixed so the container sits at `indent`. Byte-identical
  /// to raw-core's `serialize_local_adjustments` and the TypeScript
  /// `localAdjustmentBlocks` for the same layers — `LocalAdjustmentXMPTests`
  /// pins that against the shared literal.
  ///
  /// Adobe keeps each correction kind in its own array (all linear, then
  /// all radial, then all brush, then all group); an interleaved stack
  /// carries `papp:LayerOrder` so it reloads in model order (#4427).
  /// Returns the empty string when there are no layers, so an unedited
  /// model adds nothing to the document.
  static func _buildLocalAdjustmentsBlock(model: AdjustmentModel, indent: String) -> String {
    _buildLocalAdjustmentsBlock(
      LocalAdjustmentOrder.keyed(model.localAdjustments), indent: indent)
  }

  static func _buildLocalAdjustmentsBlock(
    _ layers: [KeyedLocalAdjustment], indent: String
  ) -> String {
    LocalAdjustmentXMP.containers.enumerated().compactMap { rank, tag -> String? in
      let members = layers.filter { LocalAdjustmentOrder.containerRank($0.layer.mask) == rank }
      return members.isEmpty ? nil : _localAdjustmentContainer(tag, members, indent: indent)
    }
    .joined(separator: "\n")
  }

  private static func _localAdjustmentContainer(
    _ tag: String, _ layers: [KeyedLocalAdjustment], indent: String
  ) -> String {
    let step = { (n: Int) in indent + String(repeating: " ", count: n) }
    let (i1, i2) = (step(2), step(4))
    let layerLines = layers.flatMap {
      _localAdjustmentCorrection($0.layer, indent: i2, order: $0.key)
    }
    return
      (["\(indent)<\(tag)>", "\(i1)<rdf:Seq>"] + layerLines
      + ["\(i1)</rdf:Seq>", "\(indent)</\(tag)>"]).joined(separator: "\n")
  }

  static func _localAdjustmentCorrection(
    _ layer: LocalAdjustment, indent: String, order: Double? = nil
  ) -> [String] {
    let step = { (n: Int) in indent + String(repeating: " ", count: n) }
    let (i2, i3, i4, i5, i6) = (indent, step(2), step(4), step(6), step(8))
    let bookkeeping: [String] = [
      "\(i4)crs:What=\"Correction\"",
      "\(i4)crs:CorrectionAmount=\"1\"",
      "\(i4)crs:CorrectionActive=\"True\"",
    ]
    let orderLines: [String] =
      order.map { ["\(i4)\(LocalMaskWire.layerOrderAttribute)=\"\(fmtMaskCoordinate($0))\""] }
      ?? []
    let sliderLines: [String] = LocalAdjustmentXMP.sliders.compactMap { slider -> String? in
      // Only fields actually set are written; a non-finite value is
      // not representable in XMP and is skipped like every slider.
      guard let value = slider.get(layer.adjustments), value.isFinite else { return nil }
      // The fraction-scaled keys ride Adobe's ±1 scale: the
      // canonical 2-decimal precision would quantise Maple's ±100
      // slider to whole units, so they get four (#3280 review,
      // extended to the six spatial controls by #3407) — mirrors
      // raw-core's `fmt4`.
      let text =
        LocalAdjustmentXMP.fractionScaledKeys.contains(slider.key)
        ? LocalAdjustmentXMP.fmtNum4(value) : fmtNum(value)
      return "\(i4)\(slider.key)=\"\(text)\""
    }
    let trailing: [String] =
      _localAdjustmentRangeLines(layer.range, indent: i4)
      + _maskGroupAttributes(layer.mask, indent: i4)
      + _localMetadataAttributes(layer.xmpMetadata, indent: i4)
    let attrs = bookkeeping + orderLines + sliderLines + trailing
    let opening = [
      "\(i2)<rdf:li>",
      "\(i3)<rdf:Description",
      attrs.joined(separator: "\n") + ">",
      "\(i4)<crs:CorrectionMasks>",
      "\(i5)<rdf:Seq>",
    ]
    let maskLines = _localAdjustmentMaskLines(layer.mask, indent: i6)
    let maskClosing = [
      "\(i5)</rdf:Seq>",
      "\(i4)</crs:CorrectionMasks>",
    ]
    let metadataNodes = _localMetadataNodes(layer.xmpMetadata, indent: i4)
    let closing = [
      "\(i3)</rdf:Description>",
      "\(i2)</rdf:li>",
    ]
    return [opening, maskLines, maskClosing, metadataNodes, closing].flatMap { $0 }
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

  private static func _localAdjustmentMaskLines(
    _ mask: LocalMask, indent: String, modern: Bool = false
  ) -> [String] {
    let number: (Double) -> String = modern ? _groupNumber : fmtNum
    let coordinate: (Double) -> String = modern ? _groupNumber : fmtMaskCoordinate
    switch mask {
    case .linear(let start, let end, let feather):
      return [
        "\(indent)<rdf:li",
        "\(indent)  crs:What=\"\(LocalAdjustmentXMP.maskWhat(.linear))\"",
        "\(indent)  crs:MaskValue=\"1\"",
        "\(indent)  crs:ZeroX=\"\(coordinate(start.x))\" crs:ZeroY=\"\(coordinate(start.y))\"",
        "\(indent)  crs:FullX=\"\(coordinate(end.x))\" crs:FullY=\"\(coordinate(end.y))\"",
        "\(indent)  papp:LocalFeather=\"\(number(feather))\"/>",
      ]
    case .radial(let center, let radii, let angle, let feather, let invert):
      let (top, left) = (coordinate(center.y - radii.y), coordinate(center.x - radii.x))
      let (bottom, right) = (coordinate(center.y + radii.y), coordinate(center.x + radii.x))
      let degrees = number(LocalAdjustmentXMP.radiansToDegrees(angle))
      return [
        "\(indent)<rdf:li",
        "\(indent)  crs:What=\"\(LocalAdjustmentXMP.maskWhat(.radial))\"",
        "\(indent)  crs:MaskValue=\"1\"",
        "\(indent)  crs:Top=\"\(top)\" crs:Left=\"\(left)\" crs:Bottom=\"\(bottom)\" crs:Right=\"\(right)\"",
        "\(indent)  crs:Angle=\"\(degrees)\" crs:Midpoint=\"50\" crs:Roundness=\"0\"",
        "\(indent)  crs:Feather=\"\(number(feather * (modern ? 50 : 100)))\" crs:Flipped=\"\(invert != modern ? "True" : "False")\"\(modern ? " crs:Version=\"2\"" : "")/>",
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
    case .brush:
      return _localAdjustmentBrushLines(mask, indent: indent)
    case .group(let group):
      return _maskGroupLines(group, indent: indent) { mask, indent, modern in
        _localAdjustmentMaskLines(mask, indent: indent, modern: modern)
      }
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
