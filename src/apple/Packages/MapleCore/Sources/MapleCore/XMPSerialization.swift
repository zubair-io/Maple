// XMPSerialization.swift — pure-Swift XMP parser + serializer for
// `(AdjustmentModel, CullingState)`. Split out of `AdjustmentModel.swift`
// in #632 once the additional `dc:subject` handling pushed the file past
// the 600-line hard budget (see `CONTRIBUTING.md` / `tools/budget-allowlist.txt`).
//
// This file is the single owner of the XMP wire format. The parallel split
// from #643 (`AdjustmentModel+XMP.swift`) was a duplicate created by a
// concurrent branch and was folded back in here — it now owns the S5
// effects keys (vignette / grain / split-tone) alongside the `dc:subject`
// keyword bag.
//
// Read the file header on `AdjustmentModel.swift` first — that's the
// type contract. This file owns the on-disk byte format:
//   • `XMPParser.parse(xml: String)` → `(AdjustmentModel, CullingState)`
//   • `XMPSerializer.serialize(model:culling:)` → `String`
//
// Both sides round-trip semantically with the Rust `raw_core::xmp`
// module and the TypeScript `XmpParserService` / `XmpSerializerService`
// — same fields, same value semantics, same legacy-alias precedence.
// Since #1577 the output is also byte-canonical against the TypeScript
// writer: the envelope, namespace prelude, indentation, attribute
// ordering and number codec all come from `XMPSerialization+Canonical.swift`
// and `XMPSerialization+Helpers.swift`, and `XMPCanonicalFormatTests`
// pins the result against a golden literal duplicated in the web suite.
// `docs/xmp-canonical-format.md` is the contract, including what the
// parity claim does and does not cover. When you add a new `crs:` or
// `papp:` attribute, mirror it in all three writers.

import Foundation

// MARK: - XMPParser

/// Pure-Swift XMP parser for `crs:` attributes. Reads the same attribute names as the Rust
/// `raw_core::xmp::parse()` function. Unknown attributes are silently ignored.
public struct XMPParser {
  private init() {}

  public static func parse(_ xml: String) throws -> (AdjustmentModel, CullingState) {
    var m = AdjustmentModel()
    var c = CullingState()
    let parser = XMLParser(data: Data(xml.utf8))
    let delegate = _XMPParserDelegate(
      model: m, culling: c,
      primaryDescription: XMPChildElementScanner.primaryDescription(in: xml))
    parser.delegate = delegate
    guard parser.parse() else {
      let err = parser.parserError?.localizedDescription ?? "unknown XML error"
      throw XMPError.parseError(err)
    }
    m = delegate.model
    c = delegate.culling
    // Local adjustments (#358) — collected by the nested-element walker
    // rather than the flat attribute switch; see
    // `XMPSerialization+LocalAdjustments.swift`.
    // The `papp:LayerOrder` sort (#4427) must see the merged stack.
    let groups = XMPMaskGroupSources.collect(xml)
    m.localAdjustments = LocalAdjustmentOrder.restore(
      delegate.localAdjustments.finish().filter { !XMPMaskGroupSources.isGroup($0.layer.mask) }
        + zip(groups.layers, groups.keys).map { (layer: $0, key: $1) },
      retainingKeys: XMPMaskGroupSources.hasVerbatimBrushKeys(
        xml, dropped: delegate.localAdjustments.droppedBrushContainers)
        || groups.templates.contains { !$0.layerOrders.isEmpty })
    // Repair spots (#3409) — same nested-element walker shape; see
    // `XMPSerialization+Retouch.swift`.
    m.retouchSpots = delegate.retouch.finish()
    // WB scale versioning (#1780/#1875/#1893/#1894), resolved at
    // document level: an explicit `papp:WbScaleVersion` stamp wins;
    // otherwise a document carrying the Maple `papp:` namespace AND an
    // explicit authored `crs:Temperature`/`crs:Tint` predates the
    // versioning (pre-#1756 scale, 1). Everything else — no `papp:`
    // namespace (ACR/Lightroom-authored, expressed in ACR's own
    // Robertson convention, which V5 matches exactly) or no authored WB
    // (nothing to convert) — is 5. Mirrors raw-core's `xmp::parse`.
    let unstampedIsV1 = delegate.sawPappNamespace && delegate.sawExplicitWb
    let version = delegate.wbScaleStamp ?? (unstampedIsV1 ? 1 : 5)
    let partial = delegate.temperatureSeen != delegate.tintSeen
    if partial {
      // Preserve raw legacy coordinates until the actual camera can fill the missing axis.
      m.wbScaleVersion = version
      m.partialWhiteBalance = PartialWhiteBalance(
        temperature: delegate.temperatureSeen ? m.temperature : nil,
        tint: delegate.tintSeen ? m.tint : nil, version: version)
    } else if version == 2 || version == 3 || version == 4 {
      if delegate.sawExplicitWb {
        let (t, ti) = WbDngTemperature.authoredPairToV5(
          temperature: m.temperature, tint: m.tint, version: version)
        m.temperature = t
        m.tint = ti
      }
      m.wbScaleVersion = 5
    } else {
      m.wbScaleVersion = version
    }
    return (m, c)
  }

  public static func parse(data: Data) throws -> (AdjustmentModel, CullingState) {
    guard let xml = String(data: data, encoding: .utf8) else {
      throw XMPError.notUTF8
    }
    return try parse(xml)
  }
}

public enum XMPError: Error, LocalizedError {
  case parseError(String)
  case notUTF8

  public var errorDescription: String? {
    switch self {
    case .parseError(let msg): return "XMP parse error: \(msg)"
    case .notUTF8: return "XMP sidecar is not valid UTF-8"
    }
  }
}

// MARK: - XMLParser delegate (module-internal)

/// Module-internal rather than file-private so the `rdf:Description`
/// attribute switch can live in `XMPSerialization+ParseAttrs.swift` — a
/// file-budget split, not a widening of the API. The leading underscore
/// marks it as an implementation detail of the XMP layer.
final class _XMPParserDelegate: NSObject, XMLParserDelegate {
  var model: AdjustmentModel
  var culling: CullingState
  /// Tracks whether the canonical `papp:CaptureSharpeningSigma` attribute
  /// has been applied during this element so the legacy
  /// `papp:CaptureSharpeningRadius` alias never overrides it. Swift
  /// dictionary iteration order is undefined; matches the Rust parser's
  /// `sigma_seen` precedence (PR #463).
  var captureSharpeningSigmaSeen: Bool = false
  /// Tracks whether the canonical `papp:Profile` attribute has been
  /// applied during this element so the legacy `papp:Look` migration
  /// never clobbers it. Mirrors raw-core's `profile_seen` precedence
  /// (ticket #536).
  var profileSeen: Bool = false
  /// Tracks whether `papp:ColorLabel` has been applied so the Adobe
  /// `xmp:Label` colour word never overrides it. Same precedence shape as
  /// the two flags above.
  var colorLabelSeen: Bool = false
  /// Document-level WB-scale authorship state (#1780): whether ANY
  /// element carried the Maple `papp:` namespace (declaration or
  /// attribute), and the explicit `papp:WbScaleVersion` stamp when one
  /// is present. Resolved into `model.wbScaleVersion` by
  /// `XMPParser.parse` after the walk; mirrors raw-core's `xmp::parse`.
  var sawPappNamespace: Bool = false
  var sawExplicitWb: Bool = false
  var temperatureSeen = false
  var tintSeen = false
  var wbScaleStamp: Int? = nil
  /// Namespace aliases identify Maple provenance without changing the
  /// historical prefix-based WB-scale migration above.
  var sawMapleNamespaceURI: Bool = false
  private var workflowDepth = 0
  private var namespaceScopes: [[String: String]] = []
  private let primaryDescription: XMPChildElementScanner.PrimaryDescription?
  private var topLevelDescriptionIndex = 0
  private var primaryDescriptionContext: XMPChildElementScanner.DescriptionContext?
  private var sawRdfEnvelope = false
  private var rdfEnvelopeDepth: Int?

  /// `dc:subject` is the only XMP element that isn't an attribute on
  /// `rdf:Description` — it's a nested bag of `rdf:li` children:
  ///
  ///   <dc:subject><rdf:Bag><rdf:li>kw</rdf:li>…</rdf:Bag></dc:subject>
  ///
  /// `inDCSubject` flips on while the parser is inside that subtree;
  /// `currentLi` accumulates the running text content of the active
  /// `rdf:li` element (XMLParser may deliver characters in multiple
  /// chunks for long text, so we concatenate until `didEndElement`).
  /// Duplicates are dropped during accumulation so the parse output
  /// matches `EditSession.setKeywords`'s "unique, first-occurrence wins"
  /// invariant — necessary because callers (e.g. `KeywordChipsRow`)
  /// iterate `culling.keywords` with `ForEach(id: \.self)`.
  var inDCSubject: Bool = false
  var currentLi: String?
  var parsedKeywords: [String] = []

  /// Point tone curves (#365) — the other nested construct in the schema.
  /// Four `papp:SceneLinearToneCurve*` parents, each wrapping an `rdf:Seq`
  /// of `"x, y"` `rdf:li` leaves. The walk lives in
  /// `XMPSerialization+ToneCurves.swift`; this delegate just feeds it the
  /// element / character events.
  var toneCurves = ToneCurveWalker()

  /// Local adjustments (#358) — the canonical `crs:GradientBasedCorrections`
  /// / `crs:CircularGradientBasedCorrections` containers. Same
  /// element-event feed as the tone curves; the walk lives in
  /// `XMPSerialization+LocalAdjustments.swift`.
  var localAdjustments = LocalAdjustmentWalker()

  /// Repair spots (#3409) — the `crs:RetouchAreas` container plus the
  /// legacy `crs:RetouchInfo` string form. Same element-event feed; the
  /// walk lives in `XMPSerialization+Retouch.swift`.
  var retouch = RetouchWalker()

  init(
    model: AdjustmentModel, culling: CullingState,
    primaryDescription: XMPChildElementScanner.PrimaryDescription? = nil
  ) {
    self.model = model
    self.culling = culling
    self.primaryDescription = primaryDescription
  }

  func parser(
    _ parser: XMLParser,
    didStartElement elementName: String,
    namespaceURI: String?,
    qualifiedName qName: String?,
    attributes attributeDict: [String: String]
  ) {
    // #4043: scoped workflow namespaces/checkpoints cannot alter current WB.
    if workflowDepth > 0 {
      workflowDepth += 1
      return
    }
    // XMLParser keeps prefixed attribute keys for legacy sidecar compatibility.
    // Resolve the element's namespace using its scoped declarations instead of
    // assuming an arbitrary XML prefix always names Maple's owned resource.
    let declarations = Dictionary(
      uniqueKeysWithValues: attributeDict.compactMap { key, value in
        key == "xmlns"
          ? ("", value) : (key.hasPrefix("xmlns:") ? (String(key.dropFirst(6)), value) : nil)
      })
    let namespaces =
      (namespaceScopes.last ?? ["rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#"])
      .merging(declarations) { _, current in current }
    let qualified = qName ?? elementName
    let parts = qualified.split(separator: ":", maxSplits: 1).map(String.init)
    let prefix = parts.count == 2 ? parts[0] : ""
    let local = parts.last ?? qualified
    if local == "Workflow", namespaces[prefix] == XMPCanonical.pappNamespaceURI {
      workflowDepth = 1
      return
    }
    let depth = namespaceScopes.count
    let canonicalName = XMPChildElementScanner.canonicalQualifiedName(
      qualified, namespaces: namespaces)
    // #4685: Lightroom's `crs:Look` nests the profile's own PV2012 curves and
    // grayscale flag under `crs:Parameters` — the profile's recipe, not the
    // user's edit — so the subtree is skipped whole and survives as passthrough.
    if qualified == "crs:Look" || canonicalName == "crs:Look" {
      workflowDepth = 1
      return
    }
    if !sawRdfEnvelope, depth <= 1, canonicalName == "rdf:RDF" {
      sawRdfEnvelope = true
      rdfEnvelopeDepth = depth + 1
    } else if depth == 1, rdfEnvelopeDepth == nil, primaryDescription != nil {
      workflowDepth = 1
      return
    }
    if rdfEnvelopeDepth == depth || (depth == 0 && primaryDescription == nil),
      canonicalName == "rdf:Description"
    {
      let currentIndex = topLevelDescriptionIndex
      topLevelDescriptionIndex += 1
      let context = XMPChildElementScanner.descriptionContext(
        attributes: attributeDict, namespaces: namespaces)
      if let primary = primaryDescription {
        if !primary.matches(index: currentIndex, context: context) {
          workflowDepth = 1
          return
        }
      } else if let primary = primaryDescriptionContext {
        if !primary.hasExplicitSubject || context != primary {
          workflowDepth = 1
          return
        }
      } else {
        primaryDescriptionContext = context
      }
    }
    namespaceScopes.append(namespaces)
    // dc:subject — nested keyword bag. Enter the subtree on the opening
    // `<dc:subject>` tag; track `<rdf:li>` children inside it. The XML
    // namespace *prefix* the sidecar binds to Dublin Core / RDF isn't
    // stable (any sidecar may rebind `dc` / `rdf` to a different prefix
    // and still be valid), so match on the qName's local-name suffix
    // — `:subject` / `:li` or the bare local name. Namespace processing
    // stays OFF on `XMLParser` because the rest of this delegate keys
    // every attribute lookup on prefixed names (`crs:Temperature` etc.).
    // WB-scale authorship scan (#1780) — runs for EVERY element,
    // before any early return, so nested passthrough elements
    // carrying `papp:` attributes still mark the document as
    // Maple-authored. The stamp itself is also consumed here.
    for key in attributeDict.keys where key == "xmlns:papp" || key.hasPrefix("papp:") {
      sawPappNamespace = true
    }
    for (key, uri) in attributeDict where key == "xmlns" || key.hasPrefix("xmlns:") {
      if uri == XMPCanonical.pappNamespaceURI || uri == "http://ns.justmaple.app/1.0/" {
        sawMapleNamespaceURI = true
      }
    }
    if attributeDict["crs:Temperature"] != nil || attributeDict["crs:Tint"] != nil {
      sawExplicitWb = true
    }
    if let stamp = attributeDict["papp:WbScaleVersion"], let v = Int(stamp),
      (1...5).contains(v)
    {
      wbScaleStamp = v
    }

    let qual = qName ?? elementName
    // Local adjustments (#358) and point tone curves (#365): inside
    // either subtree there are no flat Maple attributes to read, so the
    // whole attribute walk below is skipped for elements a walker claims.
    if localAdjustments.start(qual, attributes: attributeDict) {
      return
    }
    if retouch.start(qual, attributes: attributeDict) {
      return
    }
    if toneCurves.start(qual) {
      return
    }
    if Self.isLocalName(qual, "subject") {
      inDCSubject = true
      parsedKeywords.removeAll(keepingCapacity: true)
      return
    }
    if inDCSubject {
      if Self.isLocalName(qual, "li") {
        currentLi = ""
      }
      // `rdf:Bag` / `rdf:Seq` / `rdf:Alt` wrappers carry no value of
      // their own — only their `rdf:li` children do.
      return
    }

    // Process WhiteBalance preset first so explicit Temperature/Tint can override it.
    if let wb = attributeDict["crs:WhiteBalance"] {
      applyAttribute(key: "crs:WhiteBalance", value: wb)
    }
    // Pre-pass: if the canonical capture-sharpening Sigma attribute is
    // present, apply it before the legacy Radius alias so attribute
    // iteration order can't flip precedence. Mirrors raw-core's
    // `sigma_seen` flag.
    if let sigma = attributeDict["papp:CaptureSharpeningSigma"] {
      applyAttribute(key: "papp:CaptureSharpeningSigma", value: sigma)
    }
    // Pre-pass: if the canonical `papp:Profile` attribute is present,
    // apply it before the `papp:Look` legacy-migration arm so Swift's
    // unordered attribute iteration can't let `Look` overwrite the
    // explicit Profile choice. Mirrors raw-core's `profile_seen` flag.
    if let profile = attributeDict["papp:Profile"] {
      applyAttribute(key: "papp:Profile", value: profile)
    }
    // Pre-pass: `papp:ColorLabel` wins over the Adobe `xmp:Label` colour
    // word regardless of attribute iteration order.
    if let colorLabel = attributeDict["papp:ColorLabel"] {
      applyAttribute(key: "papp:ColorLabel", value: colorLabel)
    }
    // Pre-pass: discover `crs:HasCrop` before applying the rect fields —
    // mirrors raw-core's two-pass crop gate. `crs:CropAngle` is always
    // applied regardless of HasCrop (pure straighten; spec § 01 inv 3).
    let hasCrop: Bool = {
      guard let v = attributeDict["crs:HasCrop"] else { return false }
      return v == "True" || v == "true"
    }()
    for (rawKey, value) in attributeDict
    where rawKey != "crs:WhiteBalance"
      && rawKey != "papp:CaptureSharpeningSigma"
      && rawKey != "papp:Profile"
      && rawKey != "papp:ColorLabel"
    {
      applyAttribute(key: rawKey, value: value, hasCrop: hasCrop)
    }
    // Reset for the next rdf:Description (defensive — XMP normally
    // carries a single description element, but the parser must remain
    // idempotent across calls).
    captureSharpeningSigmaSeen = false
    profileSeen = false
    colorLabelSeen = false
  }

  func parser(_ parser: XMLParser, foundCharacters string: String) {
    guard workflowDepth == 0 else { return }
    toneCurves.characters(string)
    retouch.characters(string)
    guard inDCSubject, currentLi != nil else { return }
    currentLi! += string
  }

  func parser(
    _ parser: XMLParser,
    didEndElement elementName: String,
    namespaceURI: String?,
    qualifiedName qName: String?
  ) {
    if workflowDepth > 0 {
      workflowDepth -= 1
      return
    }
    _ = namespaceScopes.popLast()
    if let envDepth = rdfEnvelopeDepth, namespaceScopes.count < envDepth {
      rdfEnvelopeDepth = nil
    }
    let qual = qName ?? elementName
    localAdjustments.end(qual)
    retouch.end(qual)
    toneCurves.end(qual, into: &model)
    if inDCSubject {
      if Self.isLocalName(qual, "li"), let text = currentLi {
        // Per IPTC convention keywords are non-empty; drop blanks.
        // Dedupe at parse time so the model/UI invariant of unique
        // keywords (also enforced on the write path by
        // `EditSession.setKeywords`) holds even for hand-edited or
        // foreign sidecars. First occurrence wins so source order
        // is preserved.
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, !parsedKeywords.contains(trimmed) {
          parsedKeywords.append(trimmed)
        }
        currentLi = nil
      } else if Self.isLocalName(qual, "subject") {
        culling.keywords = parsedKeywords
        parsedKeywords = []
        inDCSubject = false
      }
    }
  }

  /// True if `qual` matches the namespaced element `local` regardless of
  /// the bound prefix — i.e. either the bare local name or any `*:local`
  /// form. Used so the parser doesn't silently ignore `dc:subject` /
  /// `rdf:li` content when a sidecar binds the namespaces to non-default
  /// prefixes.
  private static func isLocalName(_ qual: String, _ local: String) -> Bool {
    qual == local || qual.hasSuffix(":" + local)
  }
}

// MARK: - XMP Serializer

/// Emit an XMP sidecar string compatible with the `crs:` schema from a model + culling state.
/// Output is semantically round-trippable with Lightroom / Maple Hosted (same fields,
/// same value semantics) and, since #1577, byte-canonical with the TypeScript writer for
/// a model both emit the same field set for — see `docs/xmp-canonical-format.md`.
public struct XMPSerializer {
  private init() {}

  // MARK: - Internal builders (used by both serialize overloads)

  /// Build the `dc:subject` keyword-bag block at the canonical child
  /// indent, or the empty string when there are no keywords. The `dc`
  /// namespace declaration it needs is contributed separately by the
  /// callers' `extraNamespaces` list.
  static func _buildKeywordsBlock(culling: CullingState) -> String {
    guard !culling.keywords.isEmpty else { return "" }
    let indent = XMPCanonical.childIndent
    let liItems = culling.keywords.map {
      "\(indent)    <rdf:li>\(escapeXMLText($0))</rdf:li>"
    }
    return
      ([
        "\(indent)<dc:subject>",
        "\(indent)  <rdf:Bag>",
      ] + liItems + [
        "\(indent)  </rdf:Bag>",
        "\(indent)</dc:subject>",
      ]).joined(separator: "\n")
  }

  // MARK: - Public serializer

  /// Serialize a full adjustment sidecar. This is the persisted-save entry
  /// point — it always authors white balance. The decode-XMP path that
  /// needs As-Shot omission uses the internal `omitWhiteBalance` overload
  /// below, kept off this public surface so a sidecar-save call site can
  /// never accidentally drop authored WB (#1883, Copilot).
  ///
  /// `passthrough` (#2233) carries the fields the source sidecar had and
  /// Maple does not model — Lightroom mask groups, history, snapshots,
  /// `crs:ToneCurvePV2012*`. It defaults to empty because the transient
  /// documents (the decode temp-XMP, the histogram probe) genuinely have
  /// nothing to preserve; every persisted save must supply the bucket
  /// `XMPParser.parsePassthrough` read off the document being replaced.
  public static func serialize(
    model: AdjustmentModel,
    culling: CullingState,
    passthrough: XMPPassthrough = .empty
  ) -> String {
    serialize(
      model: model, culling: culling, omitWhiteBalance: false, passthrough: passthrough)
  }

  /// `omitWhiteBalance` (#1883): decode-XMP-only mode — see `_buildAttrs`.
  /// `internal` (no default) so only in-module callers — `RawCoreBridge`'s
  /// decode temp-XMP and the parity test — can request WB omission
  /// intentionally; every persisted save routes through the public two-arg
  /// form above, which always authors WB.
  static func serialize(
    model: AdjustmentModel,
    culling: CullingState,
    omitWhiteBalance: Bool,
    passthrough: XMPPassthrough = .empty
  ) -> String {
    let attrs =
      _buildAttrs(model: model, culling: culling, omitWhiteBalance: omitWhiteBalance)
      + _ratingAndLabelAttrs(culling: culling, passthrough: passthrough)
      + _passthroughAttrs(passthrough)
    let developChildren = _developChildren(model: model, passthrough: passthrough)
    let children = ([_buildKeywordsBlock(culling: culling)] + developChildren)
      .filter { !$0.isEmpty }
      .joined(separator: "\n")

    return XMPCanonical.document(
      extraNamespaces: _conditionalNamespaces(
        needed: culling.keywords.isEmpty ? [] : ["dc"], passthrough: passthrough),
      attributes: attrs,
      children: children,
      rdfNodes: passthrough.unknownRdfNodes,
      xmpmetaNodes: passthrough.unknownXmpmetaNodes)
  }

  /// The develop child blocks every serialize overload emits after the
  /// keyword bag (and, for the metadata overload, after the rights blocks),
  /// in the canonical slot order the TypeScript and C# writers use too: point
  /// tone curves (#365), the local-adjustment containers with the opaque
  /// mask-group templates spliced in (#358, #3274), the `crs:RetouchAreas`
  /// container (#3409), then the preserved unknown nodes last (#2233).
  /// Children of `rdf:Description` sit at six spaces (see
  /// `docs/xmp-canonical-format.md` § "Indentation"); empty blocks are
  /// returned as empty strings for the caller to drop. One list, shared, so
  /// a metadata-carrying save can never again omit a block the base save
  /// writes (#4687).
  static func _developChildren(
    model: AdjustmentModel, passthrough: XMPPassthrough
  ) -> [String] {
    let indent = XMPCanonical.childIndent
    return [
      _buildToneCurvesBlock(model: model, indent: indent),
      _buildLocalAdjustmentsBlockWithPassthrough(
        LocalAdjustmentOrder.keyed(model.localAdjustments, around: passthrough),
        indent: indent, templates: passthrough.maskGroups),
      _buildRetouchAreasBlock(model: model, indent: indent),
      _passthroughNodesBlock(passthrough, indent: indent),
    ]
  }

  // serialize(model:culling:metadata:) + escapeXMLAttr live in
  // XMPSerialization+MetadataWrite.swift (split out for the 600-LOC budget).
  //
  // fmtF and escapeXMLText are defined in XMPSerialization+Helpers.swift
  // (split out to stay under the 600-LOC hard budget, #1181).
  //
  // serializeMetadataOnly lives in XMPSerialization+VideoWrite.swift (#1638).
}
