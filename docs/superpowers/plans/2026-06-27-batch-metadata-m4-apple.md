# Batch Metadata Editor — M4 Apple Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SwiftUI "Edit Metadata…" action to the Browse selection bar that opens a sheet where the user can bulk-edit the 21-field XmpMetadata set across all selected assets, writing each asset's `.xmp` sidecar via the existing `XMPSerializer.serialize(model:culling:metadata:)` — non-destructively, never touching originals.

**Architecture:** Three new files cover the ViewModel, the main panel, and field subviews. One existing file (`PanoSelectionBar.swift`) gains an "Edit Metadata…" button. `AppShell.swift` gets a `@State var showBatchMetadata = false` flag and a `.sheet(isPresented:)` that presents `BatchMetadataSheet`. The ViewModel holds the `[AssetRef]` snapshot, the `[AssetRef.ID: EditSession]` reference (for reading existing XMP state), and a `TouchedMetadata` struct that tracks which fields the user actually changed. Apply is async: iterate selected assets, read existing sidecar, merge touched fields only, write via `XMPSidecarStore`.

**Tech Stack:** SwiftUI, `@Observable`, `XmpMetadata` + `XMPSerializer.serialize(model:culling:metadata:)` + `XMPParser.parseMetadata` (existing M0b API), `XMPSidecarStore.update(model:culling:)` (actor), `CLGeocoder` (address search), `CoreLocation`, `XCTest`.

## Global Constraints

- **Non-destructive:** originals never touched; only `.xmp` sidecars written.
- **Reuse M0b API exactly:** `XmpMetadata`, `CopyrightStatus`, `XMPSerializer.serialize(model:culling:metadata:)`, `XMPParser.parseMetadata(_:)` — no new encoding logic.
- **Only touched fields written:** untouched fields in the editor do not overwrite existing sidecar values.
- **Mixed-value display:** when the selection has differing values for a field, show `(mixed)` placeholder; editing replaces the value on all assets; leaving untouched preserves each asset's individual value.
- **Functional/immutable style:** `let` not `var` where value doesn't change; early-return guards; no reassigned `let`.
- **600-LOC hard limit** per file — split proactively. AppShell.swift and BrowseGrid.swift are allowlisted already; new files must stay under 600.
- **File budget:** `bash tools/check-file-budget.sh` must report 0 hard violations.
- **Closes #1629** (epic #1575); PR body must include `Closes #1629`.
- **`@Observable`** on all view models; no legacy `@ObservedObject`/`@StateObject`.
- **Actor-isolated I/O:** all sidecar reads/writes through `XMPSidecarStore` actor.
- **Generation-counter guard for async state** if any async read-then-write path exists.
- **No backup re-file offer** on Apple standalone (server feature only, per spec).
- **Platform:** macOS + iOS (phone + tablet) — the sheet is the same on all.
- **CLGeocoder** for forward geocode (Apple standalone, no server).
- **Swift tests:** `cd src/apple/Packages/MapleCore && swift test` must stay green.
- **xcodebuild build:** `xcodebuild -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build` must succeed.
- Worktree: `/Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple` branch `claude/m4-apple-batch-metadata`.
- Redirect compile output to a file (`> /tmp/m4.log 2>&1`) — never pipe `xcodebuild` or `swift test` through `tail`/`head`.

---

## File Map

| File                                                                                  | Action     | Responsibility                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift`         | **Create** | `@Observable` class holding selection snapshot, mixed-value detection, apply logic.                                                       |
| `src/apple/Maple/Views/BatchMetadata/BatchMetadataSheet.swift`                        | **Create** | Top-level sheet: section-grouped ScrollView + toolbar (Cancel / Apply).                                                                   |
| `src/apple/Maple/Views/BatchMetadata/BatchMetadataCaptureSection.swift`               | **Create** | GPS, datetime, timezone fields + CLGeocoder address search.                                                                               |
| `src/apple/Maple/Views/BatchMetadata/BatchMetadataTextSection.swift`                  | **Create** | Location text (sublocation, city, state, country, country code), Description (title, caption, headline, instructions), Creator & Rights.  |
| `src/apple/Maple/Views/PanoSelectionBar.swift`                                        | **Modify** | Add `onEditMetadata: (() -> Void)?` parameter + "Edit Metadata…" button.                                                                  |
| `src/apple/Maple/Views/AppShell.swift`                                                | **Modify** | Add `@State var showBatchMetadata = false`, wire `onEditMetadata` from `PanoSelectionBar`, add `.sheet(isPresented: $showBatchMetadata)`. |
| `src/apple/Maple/Views/BrowseGrid.swift`                                              | **Modify** | Thread `onEditMetadata` callback through to `PanoSelectionBar`.                                                                           |
| `src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift` | **Create** | Unit tests for mixed-value detection, apply logic, field-merging.                                                                         |

**Why this decomposition:** `BatchMetadataViewModel` has no SwiftUI dependency — it can be unit-tested in MapleCore. The sheet splits into three files to stay under 600 LOC: top-level sheet frame, capture-section (CLGeocoder + date logic), and text-section (IPTC text fields). `PanoSelectionBar` receives a callback (nil-optional, same pattern as `onMerge`).

---

## Task 1 — BatchMetadataViewModel (MapleCore, testable)

**Files:**

- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift`
- Test: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift`

**Interfaces:**

- Produces:
  - `public class BatchMetadataViewModel` (`@Observable`, `@MainActor`)
  - `init(assets: [AssetRef], sessions: [AssetRef.ID: EditSession])`
  - `var touchedMetadata: TouchedMetadata` — what the user changed
  - `var mixedFields: Set<MetadataFieldKey>` — fields with heterogeneous values
  - `var commonMetadata: XmpMetadata` — the value where all assets agree (or empty)
  - `func apply() async throws` — writes each sidecar
  - `enum ApplyError: Error` with `.partialFailure([(AssetRef, Error)])`

- `TouchedMetadata` struct with one `Optional` per `XmpMetadata` field — `nil` = untouched.
- `MetadataFieldKey` enum listing every editable field.

**Step 1: Write the failing tests**

- [ ] Create `src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift`:

```swift
// BatchMetadataViewModelTests.swift — unit tests for BatchMetadataViewModel.
// Tests use real XMPSidecarStore + temp directories (no mocks).

import XCTest
@testable import MapleCore

@MainActor
final class BatchMetadataViewModelTests: XCTestCase {

    // MARK: - Helpers

    /// Write a sidecar for a temp DNG URL and return the URL.
    private func tempAsset(metadata: XmpMetadata? = nil, model: AdjustmentModel = .default,
                           culling: CullingState = CullingState()) async throws -> (AssetRef, XMPSidecarStore) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("dng")
        let store = XMPSidecarStore(rawURL: url)
        if let m = metadata {
            await store.update(model: model, culling: culling, metadata: m)
        } else {
            await store.update(model: model, culling: culling)
        }
        await store.flush()
        let ref = AssetRef(url: url)
        return (ref, store)
    }

    // MARK: - Mixed-value detection

    func testMixedCityDetected() async throws {
        var m1 = XmpMetadata(); m1.city = "Paris"
        var m2 = XmpMetadata(); m2.city = "London"
        let (a1, _) = try await tempAsset(metadata: m1)
        let (a2, _) = try await tempAsset(metadata: m2)
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()
        XCTAssertTrue(vm.mixedFields.contains(.city), "City should be mixed")
        XCTAssertNil(vm.commonMetadata.city, "commonMetadata.city should be nil when mixed")
    }

    func testCommonCityAgreed() async throws {
        var m1 = XmpMetadata(); m1.city = "Paris"
        var m2 = XmpMetadata(); m2.city = "Paris"
        let (a1, _) = try await tempAsset(metadata: m1)
        let (a2, _) = try await tempAsset(metadata: m2)
        let vm = BatchMetadataViewModel(assets: [a1, a2], sessions: [:])
        await vm.loadExistingMetadata()
        XCTAssertFalse(vm.mixedFields.contains(.city), "City should not be mixed when equal")
        XCTAssertEqual(vm.commonMetadata.city, "Paris")
    }

    // MARK: - Apply: only touched fields written

    func testApplyOnlyTouchedFieldsWritten() async throws {
        var existingMeta = XmpMetadata()
        existingMeta.city = "Paris"
        existingMeta.headline = "Existing"
        let (asset, store) = try await tempAsset(metadata: existingMeta)

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // Touch only city; headline untouched.
        vm.touchedMetadata.city = "Berlin"
        try await vm.apply()

        // Reload from disk.
        let fresh = XMPSidecarStore(rawURL: asset.primaryURL!)
        let loaded = try await fresh.load()
        let result = XMPParser.parseMetadata(XMPSerializer.serialize(model: loaded.0, culling: loaded.1,
                                                                     metadata: XmpMetadata()))
        // After apply, city should be Berlin; headline must still be Existing.
        let reloaded = XMPParser.parseMetadata({
            let xml = XMPSerializer.serialize(model: loaded.0, culling: loaded.1,
                                              metadata: existingMeta)
            // Actually read the written XMP directly.
            return (try? String(contentsOf: store.url, encoding: .utf8)) ?? ""
        }())
        XCTAssertEqual(reloaded.city, "Berlin", "Touched city must be written")
        XCTAssertEqual(reloaded.headline, "Existing", "Untouched headline must be preserved")
    }

    func testApplyExplicitClear() async throws {
        var existingMeta = XmpMetadata()
        existingMeta.city = "Paris"
        let (asset, store) = try await tempAsset(metadata: existingMeta)

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        // Explicit clear: set touched to empty string.
        vm.touchedMetadata.city = ""
        try await vm.apply()

        let xml = (try? String(contentsOf: store.url, encoding: .utf8)) ?? ""
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertNil(parsed.city, "Explicitly cleared city should not appear in sidecar")
    }

    // MARK: - GPS touch

    func testApplyGPSTouched() async throws {
        let (asset, store) = try await tempAsset()
        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()
        vm.touchedMetadata.gpsLatitude = 48.8566
        vm.touchedMetadata.gpsLongitude = 2.3522
        try await vm.apply()
        let xml = (try? String(contentsOf: store.url, encoding: .utf8)) ?? ""
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.gpsLatitude!, 48.8566, accuracy: 1e-4)
        XCTAssertEqual(parsed.gpsLongitude!, 2.3522, accuracy: 1e-4)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail (compile error expected at this point)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Packages/MapleCore
swift test --filter BatchMetadataViewModelTests > /tmp/m4-t1-fail.log 2>&1
cat /tmp/m4-t1-fail.log | grep -E "error:|BUILD FAILED|PASS|FAIL" | head -20
```

Expected: BUILD FAILED (type not yet defined).

- [ ] **Step 3: Create BatchMetadataViewModel.swift**

```swift
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
/// GPS lat/lon/alt are touched together: touching lat alone without lon
/// is valid; the ViewModel merges only what is set.
public struct TouchedMetadata {
    public var gpsLatitude: Double?? = nil     // nil = untouched; .some(nil) = clear
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
    public var instructions: String? = nil
    public var creator: String? = nil
    public var creatorJobTitle: String? = nil
    public var copyrightNotice: String? = nil
    public var copyrightStatus: CopyrightStatus?? = nil  // nil = untouched
    public var usageTerms: String? = nil
    public var credit: String? = nil
    public var source: String? = nil

    public init() {}

    /// True iff at least one field has been touched.
    var hasTouched: Bool {
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

    private func readMetadata(for asset: AssetRef) async -> XmpMetadata? {
        guard let url = asset.primaryURL else { return XmpMetadata() }
        let store = XMPSidecarStore(rawURL: url)
        guard let (model, culling) = try? await store.loadIfPresent() else {
            return XmpMetadata()
        }
        let xml = XMPSerializer.serialize(model: model, culling: culling)
        return XMPParser.parseMetadata(xml)
    }

    private func applyToAsset(_ asset: AssetRef) async throws {
        guard let url = asset.primaryURL else { return }
        let store = XMPSidecarStore(rawURL: url)
        let (model, culling) = (try? await store.load()) ?? (.default, CullingState())

        // Read the existing metadata from the current sidecar.
        let existingXml = XMPSerializer.serialize(model: model, culling: culling)
        var merged = XMPParser.parseMetadata(existingXml)

        // Merge in only the touched fields.
        let t = touchedMetadata
        if let v = t.gpsLatitude   { merged.gpsLatitude   = v }
        if let v = t.gpsLongitude  { merged.gpsLongitude  = v }
        if let v = t.gpsAltitude   { merged.gpsAltitude   = v }
        if let v = t.dateTimeOriginal { merged.dateTimeOriginal = v.isEmpty ? nil : v }
        if let v = t.timeZone      { merged.timeZone      = v.isEmpty ? nil : v }
        if let v = t.sublocation   { merged.sublocation   = v.isEmpty ? nil : v }
        if let v = t.city          { merged.city          = v.isEmpty ? nil : v }
        if let v = t.state         { merged.state         = v.isEmpty ? nil : v }
        if let v = t.country       { merged.country       = v.isEmpty ? nil : v }
        if let v = t.countryCode   { merged.countryCode   = v.isEmpty ? nil : v }
        if let v = t.title         { merged.title         = v.isEmpty ? nil : v }
        if let v = t.caption       { merged.caption       = v.isEmpty ? nil : v }
        if let v = t.headline      { merged.headline      = v.isEmpty ? nil : v }
        if let v = t.instructions  { merged.instructions  = v.isEmpty ? nil : v }
        if let v = t.creator       { merged.creator       = v.isEmpty ? nil : v }
        if let v = t.creatorJobTitle { merged.creatorJobTitle = v.isEmpty ? nil : v }
        if let v = t.copyrightNotice { merged.copyrightNotice = v.isEmpty ? nil : v }
        if let v = t.copyrightStatus { merged.copyrightStatus = v }
        if let v = t.usageTerms   { merged.usageTerms   = v.isEmpty ? nil : v }
        if let v = t.credit        { merged.credit        = v.isEmpty ? nil : v }
        if let v = t.source        { merged.source        = v.isEmpty ? nil : v }

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
            let allMatch = values.allSatisfy { $0 == first }
            if allMatch {
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
            let allMatch = values.allSatisfy { $0 == first }
            if allMatch {
                common[keyPath: setPath] = first
            } else {
                mixed.insert(key)
            }
        }

        func checkCopyright(_ key: MetadataFieldKey) {
            let values = metadatas.map { $0.copyrightStatus }
            let first  = values.first ?? nil
            let allMatch = values.allSatisfy { $0 == first }
            if allMatch {
                common.copyrightStatus = first
            } else {
                mixed.insert(key)
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
        checkCopyright(.copyrightStatus)
        checkString(\.usageTerms,   \.usageTerms,   .usageTerms)
        checkString(\.credit,       \.credit,       .credit)
        checkString(\.source,       \.source,       .source)

        return (common, mixed)
    }
}
```

Note: `XMPSidecarStore.update(model:culling:metadata:)` does not yet exist (the current `update` only takes model+culling). We need to add the `metadata:` overload to `XMPSidecarStore`.

- [ ] **Step 4: Add `metadata:` overload to XMPSidecarStore**

Edit `src/apple/Packages/MapleCore/Sources/MapleCore/XMPSidecarStore.swift` to add (after the existing `update` method, around line 70):

```swift
    /// Schedule a debounced write including the IPTC/EXIF metadata block.
    public func update(model: AdjustmentModel, culling: CullingState, metadata: XmpMetadata) {
        pendingModel = model
        pendingCulling = culling
        pendingMetadata = metadata
        cached = (model, culling)

        pendingTask?.cancel()
        pendingTask = Task { [weak self] in
            do {
                try await Task.sleep(for: XMPSidecarStore.debounceInterval)
                await self?.writePending()
            } catch {
                // Task cancelled — a newer update superseded this one.
            }
        }
    }
```

And add `private var pendingMetadata: XmpMetadata? = nil` to the stored properties.

Update `writeAtomically` to:

```swift
    private func writeAtomically(model: AdjustmentModel, culling: CullingState) throws {
        let xml: String
        if let m = pendingMetadata {
            xml = XMPSerializer.serialize(model: model, culling: culling, metadata: m)
            pendingMetadata = nil
        } else {
            xml = XMPSerializer.serialize(model: model, culling: culling)
        }
        guard let data = xml.data(using: .utf8) else {
            throw XMPStoreError.encodingError
        }
        let tmpURL = sidecarURL.deletingLastPathComponent()
            .appendingPathComponent(".\(sidecarURL.lastPathComponent).tmp")
        try data.write(to: tmpURL, options: .atomic)
        _ = try FileManager.default.replaceItemAt(sidecarURL, withItemAt: tmpURL)
    }
```

- [ ] **Step 5: Adjust tests to match actual store.url API**

The test calls `store.url` (which is the `sidecarURL`). Verify that `XMPSidecarStore.url` is already `public` in the existing code (it is — line 112). The `loadIfPresent()` is also already public.

Fix the test's `testApplyOnlyTouchedFieldsWritten` to read the written sidecar directly:

```swift
    func testApplyOnlyTouchedFieldsWritten() async throws {
        var existingMeta = XmpMetadata()
        existingMeta.city = "Paris"
        existingMeta.headline = "Existing"
        let (asset, store) = try await tempAsset(metadata: existingMeta)

        let vm = BatchMetadataViewModel(assets: [asset], sessions: [:])
        await vm.loadExistingMetadata()

        vm.touchedMetadata.city = "Berlin"
        try await vm.apply()

        let xml = try String(contentsOf: store.url, encoding: .utf8)
        let parsed = XMPParser.parseMetadata(xml)
        XCTAssertEqual(parsed.city, "Berlin", "Touched city must be written")
        XCTAssertEqual(parsed.headline, "Existing", "Untouched headline must be preserved")
    }
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Packages/MapleCore
swift test --filter BatchMetadataViewModelTests > /tmp/m4-t1-pass.log 2>&1
cat /tmp/m4-t1-pass.log | grep -E "PASS|FAIL|error:" | head -20
```

Expected: all BatchMetadataViewModelTests PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
git add src/apple/Packages/MapleCore/Sources/MapleCore/BatchMetadataViewModel.swift
git add src/apple/Packages/MapleCore/Sources/MapleCore/XMPSidecarStore.swift
git add src/apple/Packages/MapleCore/Tests/MapleCoreTests/BatchMetadataViewModelTests.swift
git commit -m "$(cat <<'EOF'
feat(batch-metadata): BatchMetadataViewModel + XMPSidecarStore metadata overload (M4 #1629)

- BatchMetadataViewModel: mixed-value detection, TouchedMetadata, apply-only-touched logic
- XMPSidecarStore: add update(model:culling:metadata:) overload for M4 apply path
- BatchMetadataViewModelTests: round-trip, mixed-value, explicit-clear, GPS touch

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — BatchMetadataSheet (top-level SwiftUI shell)

**Files:**

- Create: `src/apple/Maple/Views/BatchMetadata/BatchMetadataSheet.swift`

**Interfaces:**

- Consumes: `BatchMetadataViewModel` (from Task 1)
- Produces: `struct BatchMetadataSheet: View` with `init(vm: BatchMetadataViewModel, onDismiss: () -> Void)`

**Note:** No unit test for pure-SwiftUI shell; build verification is the test here.

- [ ] **Step 1: Create the BatchMetadata directory**

```bash
mkdir -p /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Maple/Views/BatchMetadata
```

- [ ] **Step 2: Create BatchMetadataSheet.swift**

```swift
// BatchMetadataSheet.swift — top-level sheet for the Batch Metadata editor.
// Presented as a modal sheet from AppShell when the user taps "Edit Metadata…"
// in the PanoSelectionBar. Hosts the two content sections + toolbar.
//
// Ticket #1629 / epic #1575.

import SwiftUI
import MapleCore

// MARK: - BatchMetadataSheet

struct BatchMetadataSheet: View {
    @Bindable var vm: BatchMetadataViewModel
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    content
                }
            }
            .navigationTitle(navigationTitle)
            .toolbar { toolbar }
        }
        .task { await vm.loadExistingMetadata() }
        .alert("Some assets could not be updated",
               isPresented: Binding(get: { vm.applyError != nil },
                                    set: { if !$0 { vm.applyError = nil } }),
               presenting: vm.applyError) { _ in
            Button("OK", role: .cancel) {}
        } message: { err in
            if case .partialFailure(let pairs) = err {
                Text("\(pairs.count) asset(s) failed to update. Successfully written assets are not rolled back.")
            }
        }
    }

    // MARK: - Content

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                BatchMetadataCaptureSection(vm: vm)
                Divider()
                BatchMetadataTextSection(vm: vm)
            }
            .padding(.bottom, 24)
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { onDismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
            Button("Apply") {
                Task {
                    do {
                        try await vm.apply()
                        if vm.applyError == nil { onDismiss() }
                    } catch {
                        // applyError set on vm; alert driven by binding.
                    }
                }
            }
            .disabled(!vm.touchedMetadata.hasTouched)
        }
    }

    // MARK: - Helpers

    private var navigationTitle: String {
        let count = vm.assets.count
        return count == 1 ? "Edit Metadata" : "Edit Metadata (\(count) photos)"
    }
}
```

- [ ] **Step 3: Verify file stays under 600 lines**

```bash
wc -l /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Maple/Views/BatchMetadata/BatchMetadataSheet.swift
```

Expected: under 100. (It will grow slightly with preview, but won't approach 600.)

- [ ] **Step 4: Add a `#Preview` at the bottom**

```swift
#Preview {
    BatchMetadataSheet(
        vm: {
            let assets = (0..<3).map { _ in
                AssetRef(url: URL(fileURLWithPath: "/tmp/test_\(UUID().uuidString).dng"))
            }
            return BatchMetadataViewModel(assets: assets, sessions: [:])
        }(),
        onDismiss: {}
    )
}
```

- [ ] **Step 5: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
git add src/apple/Maple/Views/BatchMetadata/BatchMetadataSheet.swift
git commit -m "$(cat <<'EOF'
feat(batch-metadata): BatchMetadataSheet SwiftUI shell (M4 #1629)

Top-level navigation stack sheet: progress/content switch, Cancel/Apply toolbar,
partial-failure alert, section host.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — BatchMetadataCaptureSection (GPS + datetime + timezone)

**Files:**

- Create: `src/apple/Maple/Views/BatchMetadata/BatchMetadataCaptureSection.swift`

**Interfaces:**

- Consumes: `BatchMetadataViewModel`
- Produces: `struct BatchMetadataCaptureSection: View`
- CLGeocoder address search: `@State private var addressQuery: String`, search on commit, populate lat/lon + place text fields in `vm.touchedMetadata`.

- [ ] **Step 1: Create BatchMetadataCaptureSection.swift**

```swift
// BatchMetadataCaptureSection.swift — "Capture" section of the Batch Metadata sheet.
// Covers GPS location (address search + manual lat/lon), capture date/time,
// and time zone.
//
// CLGeocoder is used for address search (Apple standalone, no server).
// GPS fields on touchedMetadata are populated when the user picks a result.
//
// Ticket #1629 / epic #1575.

import SwiftUI
import CoreLocation
import MapleCore

// MARK: - BatchMetadataCaptureSection

struct BatchMetadataCaptureSection: View {
    @Bindable var vm: BatchMetadataViewModel

    // Address search state
    @State private var addressQuery: String = ""
    @State private var geocodeResults: [CLPlacemark] = []
    @State private var isGeocoding: Bool = false
    @State private var geocodeError: String? = nil

    // Manual lat/lon entry state (text fields that parse to Double)
    @State private var latText: String = ""
    @State private var lonText: String = ""

    // Date/time state
    @State private var dateTimeText: String = ""
    @State private var timeZoneText: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("Capture")
            locationGroup
            Divider().padding(.leading, 16)
            dateTimeGroup
        }
    }

    // MARK: - Location Group

    private var locationGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("GPS Location")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 12)

            // Address search
            HStack {
                TextField("Search address…", text: $addressQuery)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { runGeocode() }
                if isGeocoding {
                    ProgressView().controlSize(.small)
                }
                Button("Search") { runGeocode() }
                    .disabled(addressQuery.trimmingCharacters(in: .whitespaces).isEmpty || isGeocoding)
            }
            .padding(.horizontal, 16)

            if let err = geocodeError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
            }

            // Geocode results picker
            if !geocodeResults.isEmpty {
                Picker("Result", selection: Binding<CLPlacemark?>(
                    get: { nil },
                    set: { if let p = $0 { applyPlacemark(p) } }
                )) {
                    ForEach(geocodeResults, id: \.description) { p in
                        Text(placemarkLabel(p)).tag(Optional(p))
                    }
                }
                .pickerStyle(.menu)
                .padding(.horizontal, 16)
            }

            // Manual lat/lon entry
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Latitude").font(.caption).foregroundStyle(.secondary)
                    TextField(latPlaceholder, text: $latText)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: latText) { _, v in
                            if let d = Double(v) { vm.touchedMetadata.gpsLatitude = d }
                        }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Longitude").font(.caption).foregroundStyle(.secondary)
                    TextField(lonPlaceholder, text: $lonText)
                        .textFieldStyle(.roundedBorder)
                        .onChange(of: lonText) { _, v in
                            if let d = Double(v) { vm.touchedMetadata.gpsLongitude = d }
                        }
                }
            }
            .padding(.horizontal, 16)

            // Clear GPS button
            if vm.touchedMetadata.gpsLatitude != nil || vm.touchedMetadata.gpsLongitude != nil {
                Button("Clear GPS") {
                    vm.touchedMetadata.gpsLatitude = nil
                    vm.touchedMetadata.gpsLongitude = nil
                    vm.touchedMetadata.gpsAltitude = nil
                    latText = ""
                    lonText = ""
                }
                .font(.subheadline)
                .foregroundStyle(.red)
                .padding(.horizontal, 16)
            }
        }
        .padding(.bottom, 12)
    }

    // MARK: - Date/Time Group

    private var dateTimeGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Date & Time")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 12)

            VStack(alignment: .leading, spacing: 4) {
                Text("Capture date/time (ISO-8601)").font(.caption).foregroundStyle(.secondary)
                TextField(dateTimePlaceholder, text: $dateTimeText)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: dateTimeText) { _, v in
                        vm.touchedMetadata.dateTimeOriginal = v.isEmpty ? nil : v
                    }
            }
            .padding(.horizontal, 16)

            VStack(alignment: .leading, spacing: 4) {
                Text("Time zone (IANA, e.g. Europe/Paris)").font(.caption).foregroundStyle(.secondary)
                TextField(timeZonePlaceholder, text: $timeZoneText)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: timeZoneText) { _, v in
                        vm.touchedMetadata.timeZone = v.isEmpty ? nil : v
                    }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
        }
    }

    // MARK: - Geocode

    private func runGeocode() {
        let q = addressQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        isGeocoding = true
        geocodeError = nil
        geocodeResults = []
        CLGeocoder().geocodeAddressString(q) { placemarks, error in
            isGeocoding = false
            if let err = error {
                geocodeError = err.localizedDescription
            } else {
                geocodeResults = placemarks ?? []
            }
        }
    }

    private func applyPlacemark(_ p: CLPlacemark) {
        guard let loc = p.location else { return }
        let lat = loc.coordinate.latitude
        let lon = loc.coordinate.longitude
        vm.touchedMetadata.gpsLatitude  = lat
        vm.touchedMetadata.gpsLongitude = lon
        latText = String(format: "%.6f", lat)
        lonText = String(format: "%.6f", lon)
        // Populate place-text fields from placemark
        if let city = p.locality { vm.touchedMetadata.city = city }
        if let state = p.administrativeArea { vm.touchedMetadata.state = state }
        if let country = p.country { vm.touchedMetadata.country = country }
        if let code = p.isoCountryCode { vm.touchedMetadata.countryCode = code }
        geocodeResults = []
        addressQuery = ""
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 4)
    }

    private func placemarkLabel(_ p: CLPlacemark) -> String {
        [p.name, p.locality, p.country]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    private var latPlaceholder: String {
        vm.mixedFields.contains(.gpsLatitude) ? "(mixed)" :
        vm.commonMetadata.gpsLatitude.map { String(format: "%.6f", $0) } ?? ""
    }

    private var lonPlaceholder: String {
        vm.mixedFields.contains(.gpsLongitude) ? "(mixed)" :
        vm.commonMetadata.gpsLongitude.map { String(format: "%.6f", $0) } ?? ""
    }

    private var dateTimePlaceholder: String {
        vm.mixedFields.contains(.dateTimeOriginal) ? "(mixed)" :
        vm.commonMetadata.dateTimeOriginal ?? ""
    }

    private var timeZonePlaceholder: String {
        vm.mixedFields.contains(.timeZone) ? "(mixed)" :
        vm.commonMetadata.timeZone ?? ""
    }
}
```

- [ ] **Step 2: Verify line count**

```bash
wc -l /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Maple/Views/BatchMetadata/BatchMetadataCaptureSection.swift
```

Expected: under 200.

- [ ] **Step 3: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
git add src/apple/Maple/Views/BatchMetadata/BatchMetadataCaptureSection.swift
git commit -m "$(cat <<'EOF'
feat(batch-metadata): BatchMetadataCaptureSection GPS+datetime UI (M4 #1629)

CLGeocoder address search, manual lat/lon, date/time and timezone text fields,
mixed-value placeholders.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — BatchMetadataTextSection (IPTC text + rights)

**Files:**

- Create: `src/apple/Maple/Views/BatchMetadata/BatchMetadataTextSection.swift`

**Interfaces:**

- Consumes: `BatchMetadataViewModel`
- Produces: `struct BatchMetadataTextSection: View`
- Groups: Location text (sublocation, city, state, country, countryCode) + Description (title, caption, headline, instructions) + Creator & Rights (creator, creatorJobTitle, copyrightNotice, copyrightStatus, usageTerms, credit, source).

- [ ] **Step 1: Create BatchMetadataTextSection.swift**

```swift
// BatchMetadataTextSection.swift — "Location", "Description", and "Creator & Rights"
// sections of the Batch Metadata sheet. All plain-text IPTC fields.
//
// Ticket #1629 / epic #1575.

import SwiftUI
import MapleCore

// MARK: - BatchMetadataTextSection

struct BatchMetadataTextSection: View {
    @Bindable var vm: BatchMetadataViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            locationGroup
            Divider()
            descriptionGroup
            Divider()
            rightsGroup
        }
    }

    // MARK: - Location text

    private var locationGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Location")
            metadataTextField("Sublocation", placeholder: placeholder(.sublocation),
                              value: Binding(get: { vm.touchedMetadata.sublocation ?? "" },
                                            set: { vm.touchedMetadata.sublocation = $0 }))
            metadataTextField("City", placeholder: placeholder(.city),
                              value: Binding(get: { vm.touchedMetadata.city ?? "" },
                                            set: { vm.touchedMetadata.city = $0 }))
            metadataTextField("State / Province", placeholder: placeholder(.state),
                              value: Binding(get: { vm.touchedMetadata.state ?? "" },
                                            set: { vm.touchedMetadata.state = $0 }))
            metadataTextField("Country", placeholder: placeholder(.country),
                              value: Binding(get: { vm.touchedMetadata.country ?? "" },
                                            set: { vm.touchedMetadata.country = $0 }))
            metadataTextField("Country Code", placeholder: placeholder(.countryCode),
                              value: Binding(get: { vm.touchedMetadata.countryCode ?? "" },
                                            set: { vm.touchedMetadata.countryCode = $0 }))
        }
        .padding(.bottom, 12)
    }

    // MARK: - Description

    private var descriptionGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Description")
            metadataTextField("Title", placeholder: placeholder(.title),
                              value: Binding(get: { vm.touchedMetadata.title ?? "" },
                                            set: { vm.touchedMetadata.title = $0 }))
            metadataTextField("Caption (Notes)", placeholder: placeholder(.caption),
                              value: Binding(get: { vm.touchedMetadata.caption ?? "" },
                                            set: { vm.touchedMetadata.caption = $0 }))
            metadataTextField("Headline", placeholder: placeholder(.headline),
                              value: Binding(get: { vm.touchedMetadata.headline ?? "" },
                                            set: { vm.touchedMetadata.headline = $0 }))
            metadataTextField("Instructions", placeholder: placeholder(.instructions),
                              value: Binding(get: { vm.touchedMetadata.instructions ?? "" },
                                            set: { vm.touchedMetadata.instructions = $0 }))
        }
        .padding(.bottom, 12)
    }

    // MARK: - Creator & Rights

    private var rightsGroup: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Creator & Rights")
            metadataTextField("Creator / Author", placeholder: placeholder(.creator),
                              value: Binding(get: { vm.touchedMetadata.creator ?? "" },
                                            set: { vm.touchedMetadata.creator = $0 }))
            metadataTextField("Creator Job Title", placeholder: placeholder(.creatorJobTitle),
                              value: Binding(get: { vm.touchedMetadata.creatorJobTitle ?? "" },
                                            set: { vm.touchedMetadata.creatorJobTitle = $0 }))
            metadataTextField("Copyright Notice", placeholder: placeholder(.copyrightNotice),
                              value: Binding(get: { vm.touchedMetadata.copyrightNotice ?? "" },
                                            set: { vm.touchedMetadata.copyrightNotice = $0 }))
            copyrightStatusPicker
            metadataTextField("Usage Terms", placeholder: placeholder(.usageTerms),
                              value: Binding(get: { vm.touchedMetadata.usageTerms ?? "" },
                                            set: { vm.touchedMetadata.usageTerms = $0 }))
            metadataTextField("Credit", placeholder: placeholder(.credit),
                              value: Binding(get: { vm.touchedMetadata.credit ?? "" },
                                            set: { vm.touchedMetadata.credit = $0 }))
            metadataTextField("Source", placeholder: placeholder(.source),
                              value: Binding(get: { vm.touchedMetadata.source ?? "" },
                                            set: { vm.touchedMetadata.source = $0 }))
        }
        .padding(.bottom, 24)
    }

    // MARK: - Copyright status tri-state picker

    private var copyrightStatusPicker: some View {
        HStack {
            Text("Copyright Status")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 140, alignment: .leading)
            Picker("Copyright Status", selection: Binding<CopyrightStatus?>(
                get: { vm.touchedMetadata.copyrightStatus ?? vm.commonMetadata.copyrightStatus },
                set: { vm.touchedMetadata.copyrightStatus = $0 }
            )) {
                Text("(not set)").tag(Optional<CopyrightStatus>(nil))
                Text("Unknown").tag(Optional(CopyrightStatus.unknown))
                Text("Copyrighted").tag(Optional(CopyrightStatus.copyrighted))
                Text("Public Domain").tag(Optional(CopyrightStatus.publicDomain))
            }
            .pickerStyle(.segmented)
            if vm.mixedFields.contains(.copyrightStatus) {
                Text("(mixed)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Shared helpers

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 4)
    }

    private func metadataTextField(_ label: String, placeholder: String,
                                   value: Binding<String>) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 140, alignment: .leading)
            TextField(placeholder, text: value)
                .textFieldStyle(.roundedBorder)
        }
        .padding(.horizontal, 16)
    }

    /// Placeholder string for a field: "(mixed)" if heterogeneous, current common
    /// value if homogeneous, or empty string if absent.
    private func placeholder(_ key: MetadataFieldKey) -> String {
        vm.mixedFields.contains(key) ? "(mixed)" : fieldValue(key)
    }

    private func fieldValue(_ key: MetadataFieldKey) -> String {
        switch key {
        case .sublocation:    return vm.commonMetadata.sublocation ?? ""
        case .city:           return vm.commonMetadata.city ?? ""
        case .state:          return vm.commonMetadata.state ?? ""
        case .country:        return vm.commonMetadata.country ?? ""
        case .countryCode:    return vm.commonMetadata.countryCode ?? ""
        case .title:          return vm.commonMetadata.title ?? ""
        case .caption:        return vm.commonMetadata.caption ?? ""
        case .headline:       return vm.commonMetadata.headline ?? ""
        case .instructions:   return vm.commonMetadata.instructions ?? ""
        case .creator:        return vm.commonMetadata.creator ?? ""
        case .creatorJobTitle: return vm.commonMetadata.creatorJobTitle ?? ""
        case .copyrightNotice: return vm.commonMetadata.copyrightNotice ?? ""
        case .usageTerms:     return vm.commonMetadata.usageTerms ?? ""
        case .credit:         return vm.commonMetadata.credit ?? ""
        case .source:         return vm.commonMetadata.source ?? ""
        default:              return ""
        }
    }
}
```

- [ ] **Step 2: Verify line count**

```bash
wc -l /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Maple/Views/BatchMetadata/BatchMetadataTextSection.swift
```

Expected: under 200.

- [ ] **Step 3: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
git add src/apple/Maple/Views/BatchMetadata/BatchMetadataTextSection.swift
git commit -m "$(cat <<'EOF'
feat(batch-metadata): BatchMetadataTextSection IPTC text fields (M4 #1629)

Location text (sublocation, city, state, country, code), Description (title,
caption, headline, instructions), Creator & Rights (author, job title,
copyright notice/status/usage/credit/source). Mixed-value placeholders.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Wire PanoSelectionBar + BrowseGrid + AppShell

**Files:**

- Modify: `src/apple/Maple/Views/PanoSelectionBar.swift`
- Modify: `src/apple/Maple/Views/BrowseGrid.swift`
- Modify: `src/apple/Maple/Views/AppShell.swift`

**Interfaces:**

- `PanoSelectionBar` gains `let onEditMetadata: (() -> Void)?` (nil-optional, same pattern as `onMerge`).
- `BrowseGrid` gains `var onEditMetadata: (() -> Void)? = nil` and threads it into `PanoSelectionBar`.
- `AppShell` adds `@State var showBatchMetadata = false` and `openBatchMetadata()` action; sets `onEditMetadata` on both Mac/iPad and iPhone layouts.

**Step 1: Modify PanoSelectionBar**

- [ ] Edit `src/apple/Maple/Views/PanoSelectionBar.swift` — add `onEditMetadata` parameter and button. The existing file is 80 lines; the addition is ~15 lines. Add after the `onMerge` parameter:

```swift
    /// Fired when the user taps "Edit Metadata…". `nil` suppresses the button.
    let onEditMetadata: (() -> Void)?
```

Add the "Edit Metadata…" button in the HStack, between center label and "Merge to Panorama…":

```swift
                // Edit Metadata CTA (M4 #1629)
                if let onEditMetadata {
                    Button {
                        onEditMetadata()
                    } label: {
                        Label("Edit Metadata\u{2026}", systemImage: "pencil.and.list.clipboard")
                            .font(.subheadline.weight(.medium))
                    }
                    .disabled(vm.selectedIDs.isEmpty)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("Edit metadata for \(vm.selectedIDs.count) selected images")
                    .accessibilityHint(vm.selectedIDs.isEmpty
                        ? "Select at least one image to enable"
                        : "Double tap to open metadata editor")
                }
```

Update call sites that instantiate `PanoSelectionBar` (in BrowseGrid.swift) to pass `onEditMetadata: onEditMetadata`.

**Step 2: Modify BrowseGrid**

- [ ] Add `var onEditMetadata: (() -> Void)? = nil` property to `BrowseGrid` (alongside `onMergePanorama`).

- [ ] Thread it into `PanoSelectionBar`:

```swift
            if vm.isSelecting, let onMergePanorama {
                PanoSelectionBar(vm: vm, onMerge: onMergePanorama, onEditMetadata: onEditMetadata)
            }
```

**Step 3: Modify AppShellCenterColumn**

- [ ] Add `var onEditMetadata: (() -> Void)? = nil` property (alongside `onMergePanorama`).
- [ ] Thread it into `BrowseGrid`:

```swift
                    onEditMetadata: onEditMetadata
```

**Step 4: Modify AppShellMacLayout**

- [ ] Add `var onEditMetadata: (() -> Void)? = nil` property.
- [ ] Thread it into `AppShellCenterColumn` in the `browse` computed property:

```swift
                    onEditMetadata: onEditMetadata
```

**Step 5: Modify AppShell**

- [ ] Add to AppShell state:

```swift
    @State var showBatchMetadata: Bool = false
```

- [ ] Add `openBatchMetadata()` action (alongside `openPanoramaMerge()`):

```swift
    func openBatchMetadata() {
        guard !browseVM.selectedIDs.isEmpty else { return }
        showBatchMetadata = true
    }
```

- [ ] Wire `onEditMetadata` on both the Mac layout and the iPhone layout (search for `onMergePanorama: { openPanoramaMerge() }` — there are two call sites):

```swift
            onEditMetadata: { openBatchMetadata() }
```

- [ ] Add the sheet (alongside the panorama merge sheet):

```swift
        .sheet(isPresented: $showBatchMetadata) {
            BatchMetadataSheet(
                vm: BatchMetadataViewModel(
                    assets: browseVM.selectedAssets,
                    sessions: sessions
                ),
                onDismiss: { showBatchMetadata = false }
            )
        }
```

- [ ] Add `import MapleCore` is already present. Ensure `BatchMetadataSheet` and `BatchMetadataViewModel` are visible (they're in `Maple` target and `MapleCore` respectively; both are already imported in AppShell).

- [ ] **Step 6: Verify file budget**

```bash
wc -l /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Maple/Views/PanoSelectionBar.swift
wc -l /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Maple/Views/BrowseGrid.swift
wc -l /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Maple/Views/AppShell.swift
```

`AppShell.swift` and `BrowseGrid.swift` are in the allowlist; `PanoSelectionBar.swift` should stay under 100.

- [ ] **Step 7: Commit**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
git add src/apple/Maple/Views/PanoSelectionBar.swift
git add src/apple/Maple/Views/BrowseGrid.swift
git add src/apple/Maple/Views/AppShellCenterColumn.swift
git add src/apple/Maple/Views/AppShellMacLayout.swift
git add src/apple/Maple/Views/AppShell.swift
git commit -m "$(cat <<'EOF'
feat(batch-metadata): wire Edit Metadata action + sheet in shell (M4 #1629)

PanoSelectionBar: add onEditMetadata callback + "Edit Metadata…" button.
BrowseGrid / AppShellCenterColumn / AppShellMacLayout: thread callback.
AppShell: openBatchMetadata(), showBatchMetadata @State, sheet presentation.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Verification

- [ ] **Step 1: Run swift test (MapleCore only)**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/apple/Packages/MapleCore
swift test > /tmp/m4-swifttest.log 2>&1
grep -E "Test Suite|PASS|FAIL|error:|BUILD" /tmp/m4-swifttest.log | tail -20
```

Expected: All tests pass. No new failures.

- [ ] **Step 2: Run xcodebuild macOS build**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
xcodebuild -project src/apple/Maple.xcodeproj \
    -scheme "Maple Exposure" \
    -destination 'platform=macOS' \
    build > /tmp/m4-xcode.log 2>&1
grep -E "BUILD SUCCEEDED|BUILD FAILED|error:" /tmp/m4-xcode.log | head -20
```

Expected: `BUILD SUCCEEDED`.

If BUILD FAILED due to missing xcframework (libraw_ffi.a), follow CONTRIBUTING.md fast-xcframework path:

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple/src/raw-pipeline
cargo build -p raw-ffi --features gpu,pano --target aarch64-apple-darwin > /tmp/xcfw.log 2>&1
```

Then copy the `.a` and regenerate the header per `src/apple/scripts/build-xcframework.sh`. Report BLOCKED if this fails.

- [ ] **Step 3: Run file budget**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
bash tools/check-file-budget.sh > /tmp/m4-budget.log 2>&1
cat /tmp/m4-budget.log | grep -E "HARD|SOFT|0 hard" | head -10
```

Expected: 0 hard violations.

- [ ] **Step 4: Push and open PR**

```bash
cd /Users/riabuz/Projects/_Maple/.claude/worktrees/m4-apple
git push origin claude/m4-apple-batch-metadata
gh pr create \
  --title "feat(batch-metadata): M4 Apple — SwiftUI Batch Metadata panel (#1629)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `BatchMetadataViewModel` to MapleCore: mixed-value detection, `TouchedMetadata` struct, apply-only-touched-fields logic using `XMPSidecarStore` actor.
- Adds `BatchMetadataSheet` SwiftUI sheet with Cancel/Apply toolbar and partial-failure alert.
- Adds `BatchMetadataCaptureSection` (GPS via CLGeocoder address search + manual entry, date/time, timezone).
- Adds `BatchMetadataTextSection` (IPTC location text, description, creator & rights, copyright status tri-state).
- Wires "Edit Metadata…" button into `PanoSelectionBar` and threads the callback through `BrowseGrid → AppShellCenterColumn → AppShellMacLayout → AppShell`.
- `XMPSidecarStore` gains `update(model:culling:metadata:)` overload.
- All writes via existing `XMPSerializer.serialize(model:culling:metadata:)` (M0b API) — non-destructive, originals never touched.
- Mixed-value fields show `(mixed)` placeholder; only fields the user touches are written.

## Test plan

- [ ] `swift test` passes in `src/apple/Packages/MapleCore` — `BatchMetadataViewModelTests` all green, no regressions.
- [ ] `xcodebuild -project src/apple/Maple.xcodeproj -scheme "Maple Exposure" -destination 'platform=macOS' build` succeeds.
- [ ] `bash tools/check-file-budget.sh` — 0 hard violations.
- [ ] Multi-select ≥1 asset in Browse mode → "Edit Metadata…" button appears in selection bar.
- [ ] Edit city on 2 assets with different cities (mixed) → confirm `(mixed)` placeholder, type new city, Apply → both sidecars have new city.
- [ ] Leave headline untouched across assets → Apply → each asset retains its original headline.
- [ ] GPS address search → pick result → lat/lon/city/country populated in touchedMetadata.
- [ ] Cancel dismisses without writing any sidecars.

Closes #1629

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Requirement                                                       | Covered by                                     |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| "Edit Metadata…" action in selection bar                          | Task 5 (PanoSelectionBar + AppShell wiring)    |
| Enabled when ≥1 selected                                          | Task 5 (`disabled(vm.selectedIDs.isEmpty)`)    |
| Capture date/time fields                                          | Task 3 (BatchMetadataCaptureSection)           |
| Time zone field                                                   | Task 3                                         |
| GPS location via CLGeocoder                                       | Task 3                                         |
| Manual lat/lon                                                    | Task 3                                         |
| IPTC place text (sublocation, city, state, country, code)         | Task 4                                         |
| Description (title/caption/headline/instructions)                 | Task 4                                         |
| Creator & rights (all 7 fields)                                   | Task 4                                         |
| Copyright status tri-state                                        | Task 4                                         |
| Mixed-value `(mixed)` placeholder                                 | Tasks 1 + 3 + 4                                |
| Only touched fields written                                       | Task 1 (apply logic)                           |
| Explicit-clear distinct from untouched                            | Task 1 (empty string = clear, nil = untouched) |
| Apply writes via XMPSerializer.serialize(model:culling:metadata:) | Task 1 + XMPSidecarStore overload              |
| Non-destructive (originals never touched)                         | XMPSidecarStore only writes .xmp               |
| Selection snapshotted at open                                     | Task 1 (init takes `assets` snapshot)          |
| Partial failure reporting                                         | Task 2 (alert + ApplyError.partialFailure)     |
| No backup re-file offer on Apple standalone                       | Not present (correct per spec)                 |

**Placeholder scan:** None found. All steps contain actual code.

**Type consistency:**

- `TouchedMetadata.gpsLatitude` uses `Double??` (outer nil = untouched, inner nil = clear). This is correct but note: in the apply logic, `if let v = t.gpsLatitude { merged.gpsLatitude = v }` — this pattern works for `Double??` because `if let` unwraps the outer optional, leaving `v: Double?` (which can be nil = clear). Swift's `if let` on double-optional unwraps one layer, so `v` is `Optional<Double>` — which is exactly what `merged.gpsLatitude` expects. Correct.
- `copyrightStatus: CopyrightStatus??` — same pattern. Correct.
- `vm.touchedMetadata.city = nil` means untouched; `vm.touchedMetadata.city = ""` means clear. The apply logic correctly maps: `if let v = t.city { merged.city = v.isEmpty ? nil : v }`.
- `vm.touchedMetadata.city` in the UI text field binding: the getter returns `""` when nil (untouched). The setter sets the value as-is (including empty string for clear). Correct.
- `MetadataFieldKey` is public because `BatchMetadataTextSection` and `BatchMetadataCaptureSection` use it in the Maple app target, not MapleCore — wait: `MetadataFieldKey` is defined in `BatchMetadataViewModel.swift` in MapleCore, and the view files import MapleCore. `public` is required. Confirmed: enum is `public`.
- `BatchMetadataViewModel` is `@MainActor @Observable public final class` in MapleCore. The SwiftUI views in the Maple app target import MapleCore and use `@Bindable var vm: BatchMetadataViewModel`. `@Bindable` requires `@Observable`, which is satisfied. Correct.
- `vm.applyError` type is `ApplyError?`. The `.alert(presenting:)` modifier requires the value type to be an Optional that is Identifiable or used with `presenting:`. The form `.alert(_, isPresented: _, presenting: _, actions: _, message:)` accepts any type for `presenting`. Correct.

**Important constraint:** The `AppShellIPhoneShell.swift` also has `onMergePanorama` — check it passes `onEditMetadata` too. The plan covers `AppShell.swift` two call sites; the iPhone shell is wired via AppShell's dispatch, not separately. Verify in Step 5.
