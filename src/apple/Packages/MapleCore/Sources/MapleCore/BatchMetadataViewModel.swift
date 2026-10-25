// BatchMetadataViewModel.swift — view model for the Batch Metadata sheet.
// Holds a snapshot of the selected assets, detects mixed values across the
// selection, and applies only the user-touched fields back to each sidecar.
// (Spec 2026-06-26-batch-metadata-editor-design.md, ticket #1629 / epic #1575.)
//
// Non-destructive contract: originals never touched; sidecars updated via
// XMPSidecarStore.update(model:culling:metadata:) with existing model/culling
// preserved and only touched metadata fields overwritten.

import Foundation

// MARK: - MetadataFieldKey

/// Every editable metadata field, used to track mixed-value detection.
public enum MetadataFieldKey: String, CaseIterable {
  case gpsLatitude, gpsLongitude, gpsAltitude
  case dateTimeOriginal, timeZone
  case sublocation, city, state, country, countryCode
  case title, caption, headline, keywords, instructions
  case creator, creatorJobTitle, copyrightNotice, copyrightStatus
  case usageTerms, credit, source
  case rating  // Maps to CullingState.stars
  case flag  // Maps to CullingState.flag
  case hidden  // Maps to CullingState.hidden
  case colorLabel  // Maps to CullingState.colorLabel
}

// MARK: - TouchedMetadata

/// The subset of `XmpMetadata` fields the user explicitly changed.
/// `nil` means "not touched" (leave the per-asset existing value alone).
/// An empty `String?` value (i.e. `Optional("")`) means "explicitly cleared".
///
/// GPS lat/lon/alt are `Double??`: outer nil = untouched; `.some(nil)` = clear.
/// `keywords` is `[String]??`: outer nil = untouched; `.some([])` = explicit clear.
public struct TouchedMetadata {
  public var gpsLatitude: Double?? = nil
  public var gpsLongitude: Double?? = nil
  public var gpsAltitude: Double?? = nil
  public var dateTimeOriginal: String? = nil
  public var timeZone: String? = nil
  public var sublocation: String? = nil
  public var city: String? = nil
  public var state: String? = nil
  public var country: String? = nil
  public var countryCode: String? = nil
  public var title: String? = nil
  public var caption: String? = nil
  public var headline: String? = nil
  public var keywords: [String]?? = nil
  public var instructions: String? = nil
  public var creator: String? = nil
  public var creatorJobTitle: String? = nil
  public var copyrightNotice: String? = nil
  public var copyrightStatus: CopyrightStatus?? = nil
  public var usageTerms: String? = nil
  public var credit: String? = nil
  public var source: String? = nil
  /// Star rating to apply. nil = untouched; 0 = explicitly clear (no stars).
  public var stars: Int? = nil
  /// Pick/reject flag. nil = untouched.
  public var flag: CullFlag? = nil
  /// Hidden flag. nil = untouched.
  public var hidden: Bool? = nil
  /// Color label (#1656). Double-optional like `copyrightStatus`, and for
  /// the same reason: the underlying field is itself optional, so "clear
  /// the label on every selected photo" has no in-band sentinel the way
  /// `stars = 0` / `flag = .none` do. Outer nil = untouched; `.some(nil)`
  /// = explicit clear; `.some(.blue)` = set to blue.
  public var colorLabel: ColorLabel?? = nil

  public init() {}

  /// True iff at least one field has been touched.
  public var hasTouched: Bool {
    gpsLatitude != nil || gpsLongitude != nil || gpsAltitude != nil || dateTimeOriginal != nil
      || timeZone != nil || sublocation != nil || city != nil || state != nil || country != nil
      || countryCode != nil || title != nil || caption != nil || headline != nil || keywords != nil
      || instructions != nil || creator != nil || creatorJobTitle != nil || copyrightNotice != nil
      || copyrightStatus != nil || usageTerms != nil || credit != nil || source != nil
      || stars != nil || flag != nil || hidden != nil || colorLabel != nil
  }
}

// MARK: - BatchMetadataViewModel

/// Observable view model for the Batch Metadata sheet.
///
/// Lifecycle:
/// 1. Init with the current selection snapshot + session map.
/// 2. Call `loadExistingMetadata()` to populate `commonMetadata` and `mixedFields`.
/// 3. User edits fields → writes into `touchedMetadata`.
/// 4. Call `apply()` to flush touched fields to each asset's sidecar.
@MainActor
@Observable
public final class BatchMetadataViewModel: Identifiable {

  /// Snapshotted selection (immutable after init).
  public let assets: [AssetRef]

  /// Existing edit sessions, used to read the current model + culling when
  /// available — avoids a separate sidecar load for open images.
  public let sessions: [AssetRef.ID: EditSession]

  /// Fields where the selection has heterogeneous values (mixed-value).
  public private(set) var mixedFields: Set<MetadataFieldKey> = []

  /// Shared value for fields where all assets agree; nil fields are either
  /// truly nil on all assets OR mixed.
  public private(set) var commonMetadata: XmpMetadata = XmpMetadata()

  /// The keyword set shared by every asset when they all agree: the agreed list
  /// when non-empty, `[]` when all assets agree on no keywords, and `nil` only
  /// when the selection is mixed (keywords differ across assets).
  public private(set) var commonKeywords: [String]? = nil

  /// The star rating shared by all assets when they agree; nil when mixed OR
  /// when all assets have 0 stars (no rating explicitly set).
  public private(set) var commonStars: Int? = nil

  /// The flag shared by all assets when they agree (even `.none`); nil only
  /// when the selection is mixed (flags differ across assets).
  public private(set) var commonFlag: CullFlag? = nil

  /// The hidden status shared by all assets when they agree; nil only
  /// when the selection is mixed.
  public private(set) var commonHidden: Bool? = nil

  /// The color label shared by all assets when they agree; nil when the
  /// selection is mixed OR when every asset agrees on "no label". The two
  /// cases are distinguished by `mixedFields.contains(.colorLabel)` —
  /// same shape as `commonStars`, where nil covers both "mixed" and
  /// "everyone is at the unset default".
  public private(set) var commonColorLabel: ColorLabel? = nil

  /// The fields the user has explicitly touched in this editing session.
  public var touchedMetadata: TouchedMetadata = TouchedMetadata()

  /// True while `loadExistingMetadata()` is running.
  public private(set) var isLoading: Bool = false

  /// Set to non-nil after apply() if some assets failed.
  public private(set) var applyError: ApplyError? = nil

  /// Errors returned from `apply()` if writing any asset fails.
  public enum ApplyError: Error {
    /// Some writes succeeded, some failed. Already-written sidecars are
    /// NOT rolled back (per spec: partial failure reported per-asset).
    case partialFailure([(AssetRef, Error)])
  }

  /// The batch editor writes local sidecars only; a remote asset is reported
  /// as a failure rather than silently left unchanged (#4709).
  public struct UnsupportedSourceError: LocalizedError {
    public let assetName: String
    public var errorDescription: String? {
      "\(assetName) isn't stored locally, so its metadata can't be batch-edited here."
    }
  }

  private let photoKitSidecarRoot: URL?

  public init(
    assets: [AssetRef], sessions: [AssetRef.ID: EditSession],
    photoKitSidecarRoot: URL? = nil
  ) {
    self.assets = assets
    self.sessions = sessions
    self.photoKitSidecarRoot = photoKitSidecarRoot
  }

  /// Clear the apply error (called by the alert dismissal binding).
  public func clearApplyError() {
    applyError = nil
  }

  // MARK: - Load existing metadata

  /// Read the existing metadata from each asset's sidecar (or default) and
  /// compute commonMetadata + mixedFields.  Must be called once after init.
  public func loadExistingMetadata() async {
    isLoading = true
    defer { isLoading = false }

    // Read XmpMetadata (IPTC/EXIF fields), keywords, and CullingState from
    // each asset's sidecar in parallel.
    let photoKitSidecarRoot = self.photoKitSidecarRoot
    let loadedTriples: [(XmpMetadata, [String], CullingState)] = await withTaskGroup(
      of: (XmpMetadata, [String], CullingState).self
    ) { group in
      for asset in assets {
        group.addTask {
          await Self.readMetadataAndKeywords(
            for: asset, photoKitSidecarRoot: photoKitSidecarRoot)
        }
      }
      var results: [(XmpMetadata, [String], CullingState)] = []
      for await result in group { results.append(result) }
      return results
    }

    guard !loadedTriples.isEmpty else { return }

    let metadatas = loadedTriples.map(\.0)
    let keywordSets = loadedTriples.map(\.1)
    let cullingSets = loadedTriples.map(\.2)

    let (common, mixed) = BatchMetadataViewModel.detectMixed(
      metadatas: metadatas,
      keywordSets: keywordSets,
      cullingSets: cullingSets
    )
    commonMetadata = common
    commonKeywords = mixed.contains(.keywords) ? nil : keywordSets.first

    let firstStars = cullingSets.first?.stars ?? 0
    commonStars = mixed.contains(.rating) ? nil : (firstStars > 0 ? firstStars : nil)

    let firstFlag = cullingSets.first?.flag ?? .none
    commonFlag = mixed.contains(.flag) ? nil : firstFlag

    // No `?? false` coercion: `hidden` is itself tri-state (nil = never
    // explicitly touched), and when every set agrees (not mixed) the
    // shared value — nil included — IS the common value.
    let firstHidden = cullingSets.first?.hidden
    commonHidden = mixed.contains(.hidden) ? nil : firstHidden

    let firstColorLabel = cullingSets.first?.colorLabel
    commonColorLabel = mixed.contains(.colorLabel) ? nil : firstColorLabel

    mixedFields = mixed
  }

  // MARK: - Apply

  /// Write touched fields back to each asset's sidecar.
  /// Non-destructive: reads the existing model+culling+metadata per asset,
  /// merges in only touched fields, writes the merged result.
  public func apply() async throws {
    var failures: [(AssetRef, Error)] = []

    for asset in assets {
      do {
        try await applyToAsset(asset)
      } catch {
        failures.append((asset, error))
      }
    }

    if !failures.isEmpty {
      let err = ApplyError.partialFailure(failures)
      applyError = err
      throw err
    }
  }

  // MARK: - Private helpers

  /// Read the IPTC/EXIF metadata block and full CullingState (keywords, stars,
  /// flag) from the asset's sidecar.  `nonisolated` so the TaskGroup disk reads
  /// run off the main actor without round-tripping back for each asset.
  nonisolated private static func readMetadataAndKeywords(
    for asset: AssetRef, photoKitSidecarRoot: URL?
  ) async -> (XmpMetadata, [String], CullingState) {
    let xml: String
    if let url = asset.primaryURL {
      let sidecarURL = SidecarPath.sidecarURL(for: url)
      guard FileManager.default.fileExists(atPath: sidecarURL.path),
        let contents = try? String(contentsOf: sidecarURL, encoding: .utf8)
      else { return (XmpMetadata(), [], CullingState()) }
      xml = contents
    } else if asset.thumbnailProvenance == .photoKit, let id = asset.stableID,
      let store = try? makePhotoKitStore(id: id, root: photoKitSidecarRoot),
      let contents = try? await store.readWorkflowXML()
    {
      xml = contents
    } else {
      return (XmpMetadata(), [], CullingState())
    }
    let meta = XMPParser.parseMetadata(xml)
    // Parse culling for keywords, stars, and flag.
    let culling = (try? XMPParser.parse(xml))?.1 ?? CullingState()
    return (meta, culling.keywords, culling)
  }

  private func applyToAsset(_ asset: AssetRef) async throws {
    if asset.thumbnailProvenance == .photoKit, let id = asset.stableID {
      try await applyToPhotoKit(asset, id: id)
      return
    }
    guard let url = asset.primaryURL else {
      throw UnsupportedSourceError(assetName: asset.displayName)
    }

    try BatchMetadataSource.requireAvailable(asset)
    // Video gets metadata-only XMP; keywords remain out of M5 scope.
    if SidecarPath.isVideo(url) {
      let store = XMPSidecarStore(rawURL: url)
      let merged = try await mergedMetadata(from: store)
      try await store.writeMetadataOnly(merged)
      return
    }

    guard let session = sessions[asset.id] else {
      try await applyToPrimary(XMPSidecarStore(rawURL: url))
      return
    }
    // A live session's state is only trusted once its sidecar has loaded (#4708).
    await session.loadSidecar()
    guard session.hasLoadedSidecar else {
      throw session.sidecarError ?? CancellationError()
    }
    // Batch metadata targets Primary even when another variant is selected.
    guard session.workflow.selectedVariantId == WorkflowContract.primaryVariantID,
      let store = session.sidecarStore as? XMPSidecarStore
    else {
      let primary =
        (session.primarySidecarStore as? XMPSidecarStore)
        ?? XMPSidecarStore(rawURL: url)
      try await applyToPrimary(primary)
      return
    }
    // Ordered with every other culling edit on this session, and the live
    // culling re-read after the wait so an edit that landed meanwhile is kept.
    let touched = touchedMetadata
    try await session.setCulling { Self.applyTouchedCulling(touched, to: &$0) }
    await session.sidecarUpdateTask?.value
    let merged = try await mergedMetadata(from: store)
    await store.update(model: session.model, culling: session.culling, metadata: merged)
    try await store.writeConfirmed(model: session.model, culling: session.culling)
  }

  private nonisolated static func makePhotoKitStore(
    id: String, root: URL?
  ) throws -> PhotoKitSidecarStore {
    if let root {
      return PhotoKitSidecarStore(phassetLocalId: id, sidecarRoot: root)
    }
    return try PhotoKitSidecarStore(phassetLocalId: id)
  }

  private func applyToPhotoKit(_ asset: AssetRef, id: String) async throws {
    let store = try Self.makePhotoKitStore(id: id, root: photoKitSidecarRoot)
    let existingXml = try await store.readWorkflowXML() ?? ""
    var merged = XMPParser.parseMetadata(existingXml)
    Self.applyTouched(touchedMetadata, into: &merged)

    guard let session = sessions[asset.id] else {
      try await applyToPhotoKitPrimary(store, metadata: merged)
      return
    }
    await session.loadSidecar()
    guard session.hasLoadedSidecar else {
      throw session.sidecarError ?? CancellationError()
    }
    let livePhotoKitStore = session.sidecarStore as? PhotoKitSidecarStore
    let reboundPrimaryStore = session.sidecarStore as? XMPSidecarStore
    guard session.workflow.selectedVariantId == WorkflowContract.primaryVariantID,
      session.primarySidecarStore is PhotoKitSidecarStore,
      livePhotoKitStore != nil || reboundPrimaryStore != nil
    else {
      await session.sidecarUpdateTask?.value
      let primary: PhotoKitSidecarStore
      if let activePrimary = session.primarySidecarStore as? PhotoKitSidecarStore {
        primary = activePrimary
      } else {
        primary = try Self.makePhotoKitStore(id: id, root: photoKitSidecarRoot)
      }
      try await applyToPhotoKitPrimary(primary, metadata: merged)
      return
    }
    let touched = touchedMetadata
    try await session.setCulling { Self.applyTouchedCulling(touched, to: &$0) }
    await session.sidecarUpdateTask?.value
    if let livePhotoKitStore {
      await livePhotoKitStore.update(
        model: session.model, culling: session.culling, metadata: merged)
      try await livePhotoKitStore.writeConfirmed(
        model: session.model, culling: session.culling)
    } else if let reboundPrimaryStore {
      await reboundPrimaryStore.update(
        model: session.model, culling: session.culling, metadata: merged)
      try await reboundPrimaryStore.writeConfirmed(
        model: session.model, culling: session.culling)
    }
  }

  private func applyToPhotoKitPrimary(
    _ store: PhotoKitSidecarStore, metadata: XmpMetadata
  ) async throws {
    // A live session may use a different Primary store or have just
    // flushed edits. Re-read its develop/culling state before publication.
    let (model, culling) = try await store.loadIfPresent() ?? (.default, CullingState())
    await store.update(
      model: model, culling: applyingTouchedCulling(to: culling), metadata: metadata)
    try await store.writeConfirmed(
      model: model, culling: applyingTouchedCulling(to: culling))
  }

  /// A sidecar that exists but can't be read fails this asset; it is never
  /// replaced with defaults.
  private func applyToPrimary(_ store: XMPSidecarStore) async throws {
    let (model, culling) = try await store.loadIfPresent() ?? (.default, CullingState())
    let metadata = try await mergedMetadata(from: store)
    await store.update(
      model: model, culling: applyingTouchedCulling(to: culling), metadata: metadata)
    try await store.writeConfirmed(
      model: model, culling: applyingTouchedCulling(to: culling))
  }

  private func mergedMetadata(from store: XMPSidecarStore) async throws -> XmpMetadata {
    let xml = try await store.readWorkflowXML() ?? ""
    var merged = XMPParser.parseMetadata(xml)
    Self.applyTouched(touchedMetadata, into: &merged)
    return merged
  }

  private func applyingTouchedCulling(to base: CullingState) -> CullingState {
    var culling = base
    Self.applyTouchedCulling(touchedMetadata, to: &culling)
    return culling
  }

  private static func applyTouchedCulling(_ t: TouchedMetadata, to culling: inout CullingState) {
    culling = CullingState(
      stars: t.stars.map { min(max($0, 0), 5) } ?? culling.stars,
      flag: t.flag ?? culling.flag,
      keywords: t.keywords.map { $0 ?? [] } ?? culling.keywords,
      hidden: t.hidden ?? culling.hidden,
      colorLabel: t.colorLabel ?? culling.colorLabel)
  }

  private static func applyTouched(_ t: TouchedMetadata, into merged: inout XmpMetadata) {
    if let v = t.gpsLatitude { merged.gpsLatitude = v }
    if let v = t.gpsLongitude { merged.gpsLongitude = v }
    if let v = t.gpsAltitude { merged.gpsAltitude = v }
    if let v = t.dateTimeOriginal { merged.dateTimeOriginal = v.isEmpty ? nil : v }
    if let v = t.timeZone { merged.timeZone = v.isEmpty ? nil : v }
    if let v = t.sublocation { merged.sublocation = v.isEmpty ? nil : v }
    if let v = t.city { merged.city = v.isEmpty ? nil : v }
    if let v = t.state { merged.state = v.isEmpty ? nil : v }
    if let v = t.country { merged.country = v.isEmpty ? nil : v }
    if let v = t.countryCode { merged.countryCode = v.isEmpty ? nil : v }
    if let v = t.title { merged.title = v.isEmpty ? nil : v }
    if let v = t.caption { merged.caption = v.isEmpty ? nil : v }
    if let v = t.headline { merged.headline = v.isEmpty ? nil : v }
    if let v = t.instructions { merged.instructions = v.isEmpty ? nil : v }
    if let v = t.creator { merged.creator = v.isEmpty ? nil : v }
    if let v = t.creatorJobTitle { merged.creatorJobTitle = v.isEmpty ? nil : v }
    if let v = t.copyrightNotice { merged.copyrightNotice = v.isEmpty ? nil : v }
    if let v = t.copyrightStatus { merged.copyrightStatus = v }
    if let v = t.usageTerms { merged.usageTerms = v.isEmpty ? nil : v }
    if let v = t.credit { merged.credit = v.isEmpty ? nil : v }
    if let v = t.source { merged.source = v.isEmpty ? nil : v }
  }

  /// Detect which fields are mixed (differ across assets) and compute the
  /// common value (set only when all assets agree on a non-nil value).
  /// `keywordSets` is parallel to `metadatas` — the keywords from each asset's
  /// culling state, read alongside the IPTC/EXIF block.
  /// `cullingSets` carries the full CullingState for rating / flag /
  /// hidden / color-label detection.
  private static func detectMixed(
    metadatas: [XmpMetadata],
    keywordSets: [[String]],
    cullingSets: [CullingState]
  ) -> (common: XmpMetadata, mixed: Set<MetadataFieldKey>) {
    var common = XmpMetadata()
    var mixed = Set<MetadataFieldKey>()

    func checkString(
      _ keyPath: KeyPath<XmpMetadata, String?>,
      _ setPath: WritableKeyPath<XmpMetadata, String?>,
      _ key: MetadataFieldKey
    ) {
      let values = metadatas.map { $0[keyPath: keyPath] }
      let first = values.first ?? nil
      if values.allSatisfy({ $0 == first }) {
        common[keyPath: setPath] = first
      } else {
        mixed.insert(key)
      }
    }

    func checkDouble(
      _ keyPath: KeyPath<XmpMetadata, Double?>,
      _ setPath: WritableKeyPath<XmpMetadata, Double?>,
      _ key: MetadataFieldKey
    ) {
      let values = metadatas.map { $0[keyPath: keyPath] }
      let first = values.first ?? nil
      if values.allSatisfy({ $0 == first }) {
        common[keyPath: setPath] = first
      } else {
        mixed.insert(key)
      }
    }

    func checkCopyright() {
      let values = metadatas.map { $0.copyrightStatus }
      let first = values.first ?? nil
      if values.allSatisfy({ $0 == first }) {
        common.copyrightStatus = first
      } else {
        mixed.insert(.copyrightStatus)
      }
    }

    func checkKeywords() {
      let first = keywordSets.first ?? []
      if !keywordSets.allSatisfy({ $0 == first }) {
        mixed.insert(.keywords)
      }
      // common keywords are stored in commonKeywords on the VM, not in XmpMetadata.
    }

    checkDouble(\.gpsLatitude, \.gpsLatitude, .gpsLatitude)
    checkDouble(\.gpsLongitude, \.gpsLongitude, .gpsLongitude)
    checkDouble(\.gpsAltitude, \.gpsAltitude, .gpsAltitude)
    checkString(\.dateTimeOriginal, \.dateTimeOriginal, .dateTimeOriginal)
    checkString(\.timeZone, \.timeZone, .timeZone)
    checkString(\.sublocation, \.sublocation, .sublocation)
    checkString(\.city, \.city, .city)
    checkString(\.state, \.state, .state)
    checkString(\.country, \.country, .country)
    checkString(\.countryCode, \.countryCode, .countryCode)
    checkString(\.title, \.title, .title)
    checkString(\.caption, \.caption, .caption)
    checkString(\.headline, \.headline, .headline)
    checkKeywords()
    checkString(\.instructions, \.instructions, .instructions)
    checkString(\.creator, \.creator, .creator)
    checkString(\.creatorJobTitle, \.creatorJobTitle, .creatorJobTitle)
    checkString(\.copyrightNotice, \.copyrightNotice, .copyrightNotice)
    checkCopyright()
    checkString(\.usageTerms, \.usageTerms, .usageTerms)
    checkString(\.credit, \.credit, .credit)
    checkString(\.source, \.source, .source)

    // Rating (stars)
    let firstStars = cullingSets.first?.stars ?? 0
    if !cullingSets.allSatisfy({ $0.stars == firstStars }) {
      mixed.insert(.rating)
    }

    // Flag
    let firstFlag = cullingSets.first?.flag ?? .none
    if !cullingSets.allSatisfy({ $0.flag == firstFlag }) {
      mixed.insert(.flag)
    }

    // Hidden. No `?? false` coercion here: comparing against a coerced
    // non-optional baseline would report a single-element (or
    // all-untouched) set as "mixed" the moment the shared value is nil,
    // since `nil != .some(false)`.
    let firstHidden = cullingSets.first?.hidden
    if !cullingSets.allSatisfy({ $0.hidden == firstHidden }) {
      mixed.insert(.hidden)
    }

    // Color label. Optional-to-optional comparison, like `hidden`: an
    // all-unlabelled selection agrees on nil and must not read as mixed.
    let firstColorLabel = cullingSets.first?.colorLabel
    if !cullingSets.allSatisfy({ $0.colorLabel == firstColorLabel }) {
      mixed.insert(.colorLabel)
    }

    return (common, mixed)
  }
}
