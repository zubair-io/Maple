// XMPSerialization+LocalAdjustmentsBrush.swift — the `papp:BrushCorrections`
// XMP codecs (#360), split from `XMPSerialization+LocalAdjustments.swift`
// (at its file budget): the `papp:Dabs` series parser + writer and the
// `Mask/Paint` leaf emitter. `docs/xmp-canonical-format.md` § "Brush masks"
// is the contract; `raw-core/src/xmp/local_adjustments/` is the
// reference implementation this mirrors byte-for-byte on the write side
// and semantically on the read side.

import Foundation

extension LocalAdjustmentXMP {
  /// Decode the `papp:Dabs` attribute value: six whitespace-separated
  /// tokens per dab — `x y radius feather weight erase`, erase exactly
  /// `0`/`1`. Nil input is an empty stroke; a malformed series is nil
  /// (the correction is dropped).
  static func parseDabSeries(_ series: String?) -> [BrushDab]? {
    guard let series, !series.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }
    let tokens = series.split(whereSeparator: \.isWhitespace)
    guard tokens.count % 6 == 0 else { return nil }
    var dabs: [BrushDab] = []
    dabs.reserveCapacity(tokens.count / 6)
    for chunk in stride(from: 0, to: tokens.count, by: 6) {
      let erase: Bool
      switch tokens[chunk + 5] {
      case "0": erase = false
      case "1": erase = true
      default: return nil
      }
      var values: [Double] = []
      for token in tokens[chunk..<chunk + 5] {
        guard let v = Double(String(token)), v.isFinite else { return nil }
        values.append(v)
      }
      dabs.append(
        BrushDab(
          center: MaskPoint(x: values[0], y: values[1]),
          radius: values[2], feather: values[3], weight: values[4], erase: erase))
    }
    return dabs
  }

  /// Encode a dab series as the `papp:Dabs` attribute value: six
  /// whitespace-separated tokens per dab — `x y radius feather weight
  /// erase`. Positions and radius ride the 6-decimal mask-coordinate
  /// format; feather/weight ride 4 decimals (the rasterizer quantizes to
  /// R8, so deeper precision would be unwritten precision); erase is
  /// `0`/`1`. `docs/xmp-canonical-format.md` § "Brush masks" is the
  /// contract.
  ///
  /// Dabs with a non-finite field are dropped, not written: one bad stamp
  /// in hundreds is a host bug, not a misplaced mask, and emitting it
  /// would produce a sidecar raw-core's own reader rejects.
  static func writeDabSeries(_ dabs: [BrushDab]) -> String {
    dabs.filter {
      $0.center.x.isFinite && $0.center.y.isFinite && $0.radius.isFinite
        && $0.feather.isFinite && $0.weight.isFinite
    }
    .map { dab in
      [
        XMPSerializer.fmtMaskCoordinate(dab.center.x),
        XMPSerializer.fmtMaskCoordinate(dab.center.y),
        XMPSerializer.fmtMaskCoordinate(dab.radius),
        fmtNum4(dab.feather),
        fmtNum4(dab.weight),
        dab.erase ? "1" : "0",
      ].joined(separator: " ")
    }
    .joined(separator: " ")
  }
}

extension XMPSerializer {
  /// The `Mask/Paint` leaf lines. `rasterId` is never written: it is an
  /// in-process registry handle, re-resolved after load.
  static func _localAdjustmentBrushLines(_ mask: LocalMask, indent: String) -> [String] {
    guard case .brush(let dabs, let digest, _) = mask else { return [] }
    let series = LocalAdjustmentXMP.writeDabSeries(dabs)
    var lines = [
      "\(indent)<rdf:li",
      "\(indent)  crs:What=\"\(LocalAdjustmentXMP.maskWhat(.brush))\"",
      "\(indent)  crs:MaskValue=\"1\"",
      "\(indent)  papp:BrushVersion=\"\(LocalMaskWire.brushVersion)\"",
    ]
    if !series.isEmpty { lines.append("\(indent)  papp:Dabs=\"\(series)\"") }
    if !digest.isEmpty {
      lines.append("\(indent)  papp:BrushDigest=\"\(escapeXMLAttr(digest))\"")
    }
    lines[lines.count - 1] += "/>"
    return lines
  }
}
