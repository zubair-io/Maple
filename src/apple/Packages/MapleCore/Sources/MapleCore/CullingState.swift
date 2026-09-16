// CullingState.swift — the culling value types: `ColorLabel`, `CullFlag`,
// and `CullingState` (stars / flag / color label / hidden + the IPTC
// keyword bag).
//
// Split out of `AdjustmentModel.swift` in #1656: that file sat at 594
// lines and the new `colorLabel` field would have pushed it past
// `CONTRIBUTING.md`'s 600-line hard budget. Nothing else moved.
//
// The XMP read/write surface lives in `XMPSerialization.swift`
// (`XMPParser`) and `XMPSerialization+Attrs.swift` (`XMPSerializer`).

import Foundation

// ColorLabel is generated from raw-core/color_labels.rs; presentation stays local.

// MARK: - CullingState

/// Per-image metadata persisted alongside the develop model. The name is
/// historical — the struct covers culling (stars / pick / reject / color
/// label) **and** IPTC keywords (#632). Both classes of metadata share the
/// same XMP write path and have zero pixel impact, so they ride together
/// instead of spawning a third payload through every
/// `SidecarStoreProtocol` method.
public struct CullingState: Codable, Sendable, Equatable, Hashable {
  public var stars: Int  // 0..5
  public var flag: CullFlag  // pick / reject / none
  /// `nil` = never explicitly touched by the user (no `papp:Hidden`
  /// attribute is written for this sidecar — see `XMPSerializer`). Only
  /// `true`/`false` are written, and only because the user (or a batch
  /// edit) explicitly set it. This tri-state matters because the backend
  /// treats ANY written `papp:Hidden` value — including `"false"` — as an
  /// explicit override that takes precedence over an AI-driven hide or a
  /// prior hidden state; unconditionally emitting `false` on every
  /// untouched sidecar write would silently un-hide assets hidden by
  /// other means.
  public var hidden: Bool?

  /// Color label (#1656), round-tripped through the `papp:ColorLabel`
  /// attribute — the same key the web serializer writes and the API
  /// parser reads, so a label set on Apple is visible to Maple Hosted
  /// and filterable by the search API without a translation layer.
  /// `nil` = no label, and the attribute is omitted entirely rather
  /// than written empty (Adobe's absence-means-unset convention, the
  /// same one `xmp:Rating` and `papp:Flag` follow).
  public var colorLabel: ColorLabel?

  /// IPTC keywords (#632). Round-tripped through the XMP `dc:subject`
  /// element as `<dc:subject><rdf:Bag><rdf:li>kw</rdf:li>…</rdf:Bag></dc:subject>`
  /// per the Dublin Core schema. Order is preserved on the write path so
  /// the chip row renders the same sequence the user typed; the on-disk
  /// `rdf:Bag` is unordered per spec but every consumer (Lightroom, the
  /// reference renderer, the Maple parsers) honours `<rdf:li>` source
  /// order, so the preservation is in practice safe.
  public var keywords: [String]

  public init(
    stars: Int = 0,
    flag: CullFlag = .none,
    keywords: [String] = [],
    hidden: Bool? = nil,
    colorLabel: ColorLabel? = nil
  ) {
    self.stars = stars
    self.flag = flag
    self.keywords = keywords
    self.hidden = hidden
    self.colorLabel = colorLabel
  }

  // MARK: Codable

  private enum CodingKeys: String, CodingKey {
    case stars
    case flag
    case keywords
    case hidden
    case colorLabel
  }

  /// Custom `init(from:)` so any previously-persisted JSON encoded
  /// before the `keywords` / `colorLabel` fields existed decodes cleanly
  /// — the synthesised init would throw `.keyNotFound`. The XMP read path
  /// already defaults to `[]` / `nil` when the corresponding attribute is
  /// absent; this matches that contract for the JSON-Codable path too
  /// (caches, eventual settings exports, etc.).
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.stars = try container.decodeIfPresent(Int.self, forKey: .stars) ?? 0
    self.flag = try container.decodeIfPresent(CullFlag.self, forKey: .flag) ?? .none
    self.keywords = try container.decodeIfPresent([String].self, forKey: .keywords) ?? []
    self.hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden)
    self.colorLabel = try container.decodeIfPresent(ColorLabel.self, forKey: .colorLabel)
  }
}

public enum CullFlag: String, Codable, Sendable, Hashable {
  case none = "none"
  case pick = "pick"
  case reject = "reject"
}
