// XMPLocalAdjustmentOrder.swift — cross-container layer order (#4427).
// The wire form groups corrections by container (linear, radial, brush,
// group), so an interleaved model stack stamps every correction with a
// `papp:LayerOrder` key, and the reader restores that order only when every
// modeled correction carries one. Mirrors raw-core's
// `serialize_local_adjustments` / `LocalAdjustmentsWalker::finish`.

import Foundation

typealias KeyedLocalAdjustment = (layer: LocalAdjustment, key: Double?)

enum LocalAdjustmentOrder {
  static func containerRank(_ mask: LocalMask) -> Int {
    switch mask {
    case .linear: return 0
    case .radial: return 1
    case .brush: return 2
    case .bitmap, .everywhere, .group: return 3
    }
  }

  /// Each layer paired with the key it is written with: nil throughout when
  /// the stack already reads back in container order, so such a document
  /// stays byte-identical to its pre-#4427 form.
  static func keyed(_ layers: [LocalAdjustment]) -> [KeyedLocalAdjustment] {
    let ranks = layers.map { containerRank($0.mask) }
    let interleaved = zip(ranks, ranks.dropFirst()).contains { $0 > $1 }
    return layers.enumerated().map {
      (layer: $0.element, key: interleaved ? Double($0.offset) : nil)
    }
  }

  /// A key that is not a finite decimal number reads as absent, the same
  /// tolerance every other attribute on this read path gets.
  static func parseKey(_ attributes: [String: String]) -> Double? {
    attributes[LocalMaskWire.layerOrderAttribute].flatMap(parseKey)
  }

  private static func parseKey(_ raw: String) -> Double? {
    let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    // Decimal grammar only: `Double` alone also takes hex floats and "nan".
    guard !text.isEmpty, text.allSatisfy({ "0123456789+-.eE".contains($0) }),
      let value = Double(text), value.isFinite
    else { return nil }
    return value
  }

  /// `retainingKeys` keeps each read key on the layer, for a sidecar whose
  /// verbatim corrections the writer must order around.
  static func restore(_ layers: [KeyedLocalAdjustment], retainingKeys: Bool) -> [LocalAdjustment] {
    let stamped = layers.map { entry -> KeyedLocalAdjustment in
      var layer = entry.layer
      layer.xmpLayerOrder = retainingKeys ? entry.key : nil
      return (layer, entry.key)
    }
    let keys = stamped.compactMap(\.key)
    guard keys.count == stamped.count else { return stamped.map(\.layer) }
    return zip(keys, stamped).enumerated()
      .sorted { ($0.element.0, $0.offset) < ($1.element.0, $1.offset) }
      .map(\.element.1.layer)
  }
}

// MARK: - Verbatim corrections

/// Keyed corrections Maple re-emits from source text rather than the model —
/// a brush container holding a stroke this build cannot read, and the opaque
/// parts of group templates. Their keys are only read, never rewritten: the
/// modeled layers are keyed around them, keeping every existing key stable
/// so a read key held in memory stays valid across saves.
extension LocalAdjustmentOrder {
  private static let keyPattern = try! NSRegularExpression(
    pattern: NSRegularExpression.escapedPattern(for: LocalMaskWire.layerOrderAttribute)
      + "\\s*=\\s*([\"'])([^\"']*)\\1")

  private static func keys(in text: String) -> [Double] {
    keyPattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
      Range($0.range(at: 2), in: text).flatMap { parseKey(String(text[$0])) }
    }
  }

  private static func isBrushContainer(_ node: String) -> Bool {
    let tag = "<" + LocalAdjustmentXMP.brushContainer
    guard node.hasPrefix(tag), let next = node.dropFirst(tag.count).first else { return false }
    return next.isWhitespace || next == ">" || next == "/"
  }

  private static func templateTexts(_ templates: [XMPMaskGroupTemplate]) -> [String] {
    templates.flatMap(\.parts).compactMap {
      guard case .text(let text) = $0 else { return nil }
      return text
    }
  }

  static func hasVerbatimKeys(_ templates: [XMPMaskGroupTemplate]) -> Bool {
    templateTexts(templates).contains { !keys(in: $0).isEmpty }
  }

  /// The keys each modeled layer is written with. With no keyed verbatim
  /// correction this is `keyed(_:)`. Otherwise every layer is keyed: a
  /// longest increasing run of read keys keeps them, and each other layer
  /// lands between the key before it and the next kept or verbatim key.
  static func keyed(_ layers: [LocalAdjustment], around passthrough: XMPPassthrough)
    -> [KeyedLocalAdjustment]
  {
    let verbatim =
      (templateTexts(passthrough.maskGroups)
      + passthrough.unknownNodes.filter(isBrushContainer)).flatMap { keys(in: $0) }
    guard !verbatim.isEmpty else { return keyed(layers) }
    let readKeys = layers.map(\.xmpLayerOrder)
    let kept = keptIndices(readKeys)
    let assigned = readKeys.indices.reduce(into: [Double]()) { assigned, index in
      if kept.contains(index), let read = readKeys[index] {
        assigned.append(read)
        return
      }
      let lower = assigned.last
      let later = kept.filter { $0 > index }.compactMap { readKeys[$0] }
      let above = verbatim.filter { key in lower.map { key > $0 } ?? true }
      switch (lower, (later + above).min()) {
      case (nil, nil): assigned.append(0)
      case (nil, let upper?): assigned.append(upper - 1)
      case (let lower?, nil): assigned.append(lower.rounded(.down) + 1)
      case (let lower?, let upper?): assigned.append((lower + upper) / 2)
      }
    }
    return zip(layers, assigned).map { (layer: $0, key: $1) }
  }

  /// A longest strictly increasing subsequence of the read keys. Ties pick
  /// the smallest predecessor and the latest end, so every host keeps the
  /// same layers.
  private static func keptIndices(_ keys: [Double?]) -> Set<Int> {
    var length = [Int](repeating: 0, count: keys.count)
    var previous = [Int?](repeating: nil, count: keys.count)
    for index in keys.indices {
      guard let key = keys[index] else { continue }
      let best = (0..<index).filter { keys[$0].map { $0 < key } ?? false }
        .max { (length[$0], -$0) < (length[$1], -$1) }
      length[index] = 1 + (best.map { length[$0] } ?? 0)
      previous[index] = best
    }
    guard let longest = length.max(), longest > 0,
      let end = keys.indices.last(where: { length[$0] == longest })
    else { return [] }
    return Set(sequence(first: end) { previous[$0] })
  }
}
