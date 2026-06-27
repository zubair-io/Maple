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
    case title, caption, headline, instructions
    case creator, creatorJobTitle, copyrightNotice, copyrightStatus
    case usageTerms, credit, source
}

// MARK: - TouchedMetadata

/// The subset of `XmpMetadata` fields the user explicitly changed.
/// `nil` means "not touched" (leave the per-asset existing value alone).
/// An empty `String?` value (i.e. `Optional("")`) means "explicitly cleared".
///
/// GPS lat/lon/alt are `Double??`: outer nil = untouched; `.some(nil)` = clear.
public struct TouchedMetadata {
    public var gpsLatitude:  Optional<Optional<Double>> = nil
    public var gpsLongitude: Optional<Optional<Double>> = nil
    public var gpsAltitude:  Optional<Optional<Double>> = nil
    public var dateTimeOriginal: String? = nil
    public var timeZone:         String? = nil
    public var sublocation:      String? = nil
    public var city:             String? = nil
    public var state:            String? = nil
    public var country:          String? = nil
    public var countryCode:      String? = nil
    public var title:            String? = nil
    public var caption:          String? = nil
    public var headline:         String? = nil
    public var instructions:     String? = nil
    public var creator:          String? = nil
    public var creatorJobTitle:  String? = nil
    public var copyrightNotice:  String? = nil
    public var copyrightStatus:  Optional<Optional<CopyrightStatus>> = nil
    public var usageTerms:       String? = nil
    public var credit:           String? = nil
    public var source:           String? = nil

    public init() {}

    /// True iff at least one field has been touched.
    public var hasTouched: Bool {
        gpsLatitude != nil || gpsLongitude != nil || gpsAltitude != nil ||
        dateTimeOriginal != nil || timeZone != nil ||
        sublocation != nil || city != nil || state != nil ||
        country != nil || countryCode != nil ||
        title != nil || caption != nil || headline != nil || instructions != nil ||
        creator != nil || creatorJobTitle != nil || copyrightNotice != nil ||
        copyrightStatus != nil || usageTerms != nil || credit != nil || source != nil
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
public final class BatchMetadataViewModel {

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

    public init(assets: [AssetRef], sessions: [AssetRef.ID: EditSession]) {
        self.assets = assets
        self.sessions = sessions
    }

    // MARK: - Load existing metadata

    /// Read the existing metadata from each asset's sidecar (or default) and
    /// compute commonMetadata + mixedFields.  Must be called once after init.
    public func loadExistingMetadata() async {
        isLoading = true
        defer { isLoading = false }

        let loadedMetadatas: [XmpMetadata] = await withTaskGroup(of: XmpMetadata?.self) { group in
            for asset in assets {
                group.addTask { [weak self] in
                    await self?.readMetadata(for: asset)
                }
            }
            var results: [XmpMetadata] = []
            for await result in group {
                if let m = result { results.append(m) }
            }
            return results
        }

        guard !loadedMetadatas.isEmpty else { return }

        let (common, mixed) = BatchMetadataViewModel.detectMixed(metadatas: loadedMetadatas)
        commonMetadata = common
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

    /// Read metadata from the asset's sidecar XML directly.
    /// The sidecar is read from disk so the metadata block is preserved —
    /// re-serializing with the 2-param `serialize(model:culling:)` would drop it.
    private func readMetadata(for asset: AssetRef) async -> XmpMetadata? {
        guard let url = asset.primaryURL else { return XmpMetadata() }
        let sidecarURL = url.deletingPathExtension().appendingPathExtension("xmp")
        guard FileManager.default.fileExists(atPath: sidecarURL.path),
              let xml = try? String(contentsOf: sidecarURL, encoding: .utf8)
        else {
            return XmpMetadata()
        }
        return XMPParser.parseMetadata(xml)
    }

    private func applyToAsset(_ asset: AssetRef) async throws {
        guard let url = asset.primaryURL else { return }
        let store = XMPSidecarStore(rawURL: url)

        // Prefer the live model+culling from an open EditSession to avoid
        // overwriting uncommitted slider changes with stale sidecar values.
        // Note: we still write via a fresh XMPSidecarStore because the session's
        // internal store is private. A cross-store debounce race remains if the
        // session flushes after us — acceptable in M4 scope; revisit when
        // EditSession exposes an apply(metadata:) API.
        let (model, culling): (AdjustmentModel, CullingState)
        if let session = sessions[asset.id] {
            (model, culling) = (session.model, session.culling)
        } else {
            (model, culling) = (try? await store.load()) ?? (.default, CullingState())
        }

        // Read the existing metadata from the sidecar XML on disk.
        let sidecarURL = url.deletingPathExtension().appendingPathExtension("xmp")
        let existingXml = (try? String(contentsOf: sidecarURL, encoding: .utf8)) ?? ""
        var merged = XMPParser.parseMetadata(existingXml)

        // Merge in only the touched fields.
        let t = touchedMetadata
        // GPS: Double?? — outer nil = untouched; .some(v) means set/clear.
        if let v = t.gpsLatitude   { merged.gpsLatitude   = v }
        if let v = t.gpsLongitude  { merged.gpsLongitude  = v }
        if let v = t.gpsAltitude   { merged.gpsAltitude   = v }
        // String fields: nil = untouched, "" = explicit clear, else = new value.
        if let v = t.dateTimeOriginal { merged.dateTimeOriginal = v.isEmpty ? nil : v }
        if let v = t.timeZone         { merged.timeZone         = v.isEmpty ? nil : v }
        if let v = t.sublocation      { merged.sublocation      = v.isEmpty ? nil : v }
        if let v = t.city             { merged.city             = v.isEmpty ? nil : v }
        if let v = t.state            { merged.state            = v.isEmpty ? nil : v }
        if let v = t.country          { merged.country          = v.isEmpty ? nil : v }
        if let v = t.countryCode      { merged.countryCode      = v.isEmpty ? nil : v }
        if let v = t.title            { merged.title            = v.isEmpty ? nil : v }
        if let v = t.caption          { merged.caption          = v.isEmpty ? nil : v }
        if let v = t.headline         { merged.headline         = v.isEmpty ? nil : v }
        if let v = t.instructions     { merged.instructions     = v.isEmpty ? nil : v }
        if let v = t.creator          { merged.creator          = v.isEmpty ? nil : v }
        if let v = t.creatorJobTitle  { merged.creatorJobTitle  = v.isEmpty ? nil : v }
        if let v = t.copyrightNotice  { merged.copyrightNotice  = v.isEmpty ? nil : v }
        if let v = t.copyrightStatus  { merged.copyrightStatus  = v }
        if let v = t.usageTerms       { merged.usageTerms       = v.isEmpty ? nil : v }
        if let v = t.credit           { merged.credit           = v.isEmpty ? nil : v }
        if let v = t.source           { merged.source           = v.isEmpty ? nil : v }

        await store.update(model: model, culling: culling, metadata: merged)
        await store.flush()
    }

    /// Detect which fields are mixed (differ across assets) and compute the
    /// common value (set only when all assets agree on a non-nil value).
    private static func detectMixed(
        metadatas: [XmpMetadata]
    ) -> (common: XmpMetadata, mixed: Set<MetadataFieldKey>) {
        var common = XmpMetadata()
        var mixed  = Set<MetadataFieldKey>()

        func checkString(_ keyPath: KeyPath<XmpMetadata, String?>,
                         _ setPath: WritableKeyPath<XmpMetadata, String?>,
                         _ key: MetadataFieldKey) {
            let values = metadatas.map { $0[keyPath: keyPath] }
            let first  = values.first ?? nil
            if values.allSatisfy({ $0 == first }) {
                common[keyPath: setPath] = first
            } else {
                mixed.insert(key)
            }
        }

        func checkDouble(_ keyPath: KeyPath<XmpMetadata, Double?>,
                         _ setPath: WritableKeyPath<XmpMetadata, Double?>,
                         _ key: MetadataFieldKey) {
            let values = metadatas.map { $0[keyPath: keyPath] }
            let first  = values.first ?? nil
            if values.allSatisfy({ $0 == first }) {
                common[keyPath: setPath] = first
            } else {
                mixed.insert(key)
            }
        }

        func checkCopyright() {
            let values = metadatas.map { $0.copyrightStatus }
            let first  = values.first ?? nil
            if values.allSatisfy({ $0 == first }) {
                common.copyrightStatus = first
            } else {
                mixed.insert(.copyrightStatus)
            }
        }

        checkDouble(\.gpsLatitude,  \.gpsLatitude,  .gpsLatitude)
        checkDouble(\.gpsLongitude, \.gpsLongitude, .gpsLongitude)
        checkDouble(\.gpsAltitude,  \.gpsAltitude,  .gpsAltitude)
        checkString(\.dateTimeOriginal, \.dateTimeOriginal, .dateTimeOriginal)
        checkString(\.timeZone,     \.timeZone,     .timeZone)
        checkString(\.sublocation,  \.sublocation,  .sublocation)
        checkString(\.city,         \.city,         .city)
        checkString(\.state,        \.state,        .state)
        checkString(\.country,      \.country,      .country)
        checkString(\.countryCode,  \.countryCode,  .countryCode)
        checkString(\.title,        \.title,        .title)
        checkString(\.caption,      \.caption,      .caption)
        checkString(\.headline,     \.headline,     .headline)
        checkString(\.instructions, \.instructions, .instructions)
        checkString(\.creator,      \.creator,      .creator)
        checkString(\.creatorJobTitle, \.creatorJobTitle, .creatorJobTitle)
        checkString(\.copyrightNotice, \.copyrightNotice, .copyrightNotice)
        checkCopyright()
        checkString(\.usageTerms,   \.usageTerms,   .usageTerms)
        checkString(\.credit,       \.credit,       .credit)
        checkString(\.source,       \.source,       .source)

        return (common, mixed)
    }
}
