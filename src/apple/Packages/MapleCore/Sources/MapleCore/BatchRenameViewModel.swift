// BatchRenameViewModel.swift — view model for the Batch Rename sheet
// (#2641, design doc § "Rename" — batch). Holds a snapshot of the selected
// assets, renders a live before→after preview through the shared
// `raw-core` template engine (`FilenameTemplateEngine`), and applies
// SEQUENTIALLY — a shared-destination template can collide with itself
// mid-batch, not only with a pre-existing file, so each item must see the
// PREVIOUS item's already-applied result before it renders/resolves its
// own collision. Matches `library/batch-rename.ts`'s contract exactly
// (its doc comment explains why `Promise.all` is never used there; the
// same reasoning is why this file's apply loops are plain sequential
// `for` loops, never a `TaskGroup`).
//
// Routes by source kind, mirroring the single-asset rename ticket (#2638):
//   • Filesystem — `LocalFileOperations.relocate`, one call per asset.
//   • SMB        — `SMBSource.renameAsset`, one call per asset.
//   • Cloud       — ONE `RemoteCatalog.batchRename` call for the whole
//     selection; the server already applies sequentially and is the
//     authoritative source for EXIF `captured_at` (indexed server-side),
//     so Cloud preview/apply round-trip to the API rather than
//     reimplementing EXIF extraction here.
//   • PhotoKit / not-yet-indexed Cloud — `.unsupported(reason)`, surfaced
//     inline per item rather than a silent no-op (design doc: "PhotoKit →
//     not supported — UI disables/explains").
//
// A `BatchRenameViewModel` is constructed against ONE routing decision for
// the whole selection: a Browse multi-select is always drawn from a single
// `browseVM.currentSource`, so the assets it carries share one source kind
// in every real call site. Per-asset fallbacks below (a Cloud asset with no
// `stableID`, an SMB asset with no id) still degrade that one asset to
// `.failed` rather than crashing the whole batch — defensive, not load-
// bearing for the common path.

import Foundation

// MARK: - Routing

/// How this batch's assets will be renamed. Decided once, from the
/// selection's shared source kind — see the file header.
public enum BatchRenameRouting: Equatable, Sendable {
    case filesystem
    case smb
    case cloud
    /// PhotoKit has no user-writable path, or the assets aren't routable
    /// (mixed/empty selection). `String` is the user-facing reason.
    case unsupported(String)
}

// MARK: - Collision policy

/// The batch-rename collision choices surfaced in the sheet. `.autoSuffix`
/// and the API's `"keep-both"` are, per `fs/relocate.ts`'s own doc comment,
/// "the exact same suffixing" — offering both as separate UI choices would
/// only be two buttons for one behavior, so this sheet exposes the three
/// behaviors that actually differ.
public enum BatchRenameCollisionChoice: String, CaseIterable, Identifiable, Hashable, Sendable {
    case autoSuffix
    case skip
    case replace

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .autoSuffix: return "Keep Both (auto-number)"
        case .skip: return "Skip"
        case .replace: return "Replace"
        }
    }

    /// The literal `POST /api/assets/batch-rename` expects.
    var apiValue: String {
        switch self {
        case .autoSuffix: return "auto-suffix"
        case .skip: return "skip"
        case .replace: return "replace"
        }
    }

    /// `LocalFileOperations`/`SMBFileOperations.relocate`'s equivalent.
    /// `.skip` maps to `.fail` — those engines have no native "skip and
    /// keep going" mode, so the apply loop below catches
    /// `FileOperationError.destinationExists` and turns it into a skipped
    /// result instead of a failure exactly when the user chose `.skip`.
    var localPolicy: CollisionPolicy {
        switch self {
        case .autoSuffix: return .autoSuffix
        case .skip: return .fail
        case .replace: return .replace
        }
    }
}

// MARK: - Preview / apply item shapes

public struct BatchRenamePreviewItem: Identifiable, Equatable, Sendable {
    public let id: AssetRef.ID
    public let oldFilename: String
    public var newFilename: String?
    public var error: String?
    /// True when an EARLIER item in this same preview rendered the
    /// identical name — a self-colliding template, surfaced before the
    /// user ever applies it (matches the API preview's `duplicate` field).
    public var duplicate: Bool = false
}

public enum BatchRenameItemOutcome: Equatable, Sendable {
    case renamed(newFilename: String)
    case skipped(reason: String)
    case failed(String)
}

public struct BatchRenameApplyResult: Identifiable, Equatable, Sendable {
    public let id: AssetRef.ID
    public let oldFilename: String
    public let outcome: BatchRenameItemOutcome
}

// MARK: - BatchRenameViewModel

@MainActor
@Observable
public final class BatchRenameViewModel: Identifiable {

    /// Snapshotted selection (immutable after init), in the order the user
    /// selected/the grid presented them — this order IS the `{n}` sequence
    /// order and the self-collision order, so it must never be re-sorted.
    public let assets: [AssetRef]
    public let routing: BatchRenameRouting

    /// Live SMB source for `.smb` routing. `nil` for every other routing.
    private let smbSource: SMBSource?
    /// Live Cloud catalog client for `.cloud` routing. `nil` for every
    /// other routing.
    private let cloudCatalog: RemoteCatalog?

    public var template: String = "{original}"
    public var sequenceStart: Int = 1
    public var sequencePadWidth: Int = 0
    public var collision: BatchRenameCollisionChoice = .autoSuffix

    public private(set) var preview: [BatchRenamePreviewItem]
    public private(set) var isPreviewing = false
    public private(set) var isApplying = false
    public private(set) var applyResults: [BatchRenameApplyResult]?

    public init(
        assets: [AssetRef],
        routing: BatchRenameRouting,
        smbSource: SMBSource? = nil,
        cloudCatalog: RemoteCatalog? = nil
    ) {
        self.assets = assets
        self.routing = routing
        self.smbSource = smbSource
        self.cloudCatalog = cloudCatalog
        self.preview = assets.map {
            BatchRenamePreviewItem(id: $0.id, oldFilename: Self.fullFilename($0))
        }
    }

    /// `false` while the routing is unsupported, the selection is empty, or
    /// the current preview has nothing renamable — drives the sheet's Apply
    /// button.
    public var canApply: Bool {
        guard !assets.isEmpty else { return false }
        guard case .unsupported = routing else {
            return preview.contains { $0.newFilename != nil && $0.error == nil }
        }
        return false
    }

    // MARK: - Preview

    /// Re-render every item's preview from the current `template` /
    /// `sequenceStart` / `sequencePadWidth`. Cheap enough to call on every
    /// keystroke for Filesystem/SMB (pure string logic, no filesystem I/O
    /// beyond a metadata-only EXIF read); Cloud debounces at the call site
    /// since it's a network round trip — see `BatchRenameSheet`.
    public func refreshPreview() async {
        guard !assets.isEmpty else { return }
        isPreviewing = true
        defer { isPreviewing = false }
        switch routing {
        case .unsupported(let reason):
            preview = assets.map {
                BatchRenamePreviewItem(id: $0.id, oldFilename: Self.fullFilename($0), error: reason)
            }
        case .filesystem, .smb:
            preview = Self.renderLocalPreview(
                assets: assets, template: template,
                sequenceStart: sequenceStart, sequencePadWidth: sequencePadWidth)
        case .cloud:
            preview = await renderCloudPreview()
        }
    }

    /// Filesystem/SMB preview — the same template engine apply() uses,
    /// applied in ORDER so a self-colliding template is flagged
    /// (`duplicate`) exactly like the API preview does for Cloud. No
    /// filesystem writes; `SidecarPath`/`FileManager` are never touched
    /// here.
    private static func renderLocalPreview(
        assets: [AssetRef], template: String, sequenceStart: Int, sequencePadWidth: Int
    ) -> [BatchRenamePreviewItem] {
        var seen = Set<String>()
        var items: [BatchRenamePreviewItem] = []
        items.reserveCapacity(assets.count)
        for (index, asset) in assets.enumerated() {
            let full = fullFilename(asset)
            let (stem, ext) = splitStemExt(full)
            do {
                let rendered = try FilenameTemplateEngine.render(
                    template: template, originalStem: stem, ext: ext,
                    capturedAtExifString: capturedAtExifString(for: asset),
                    sequenceStart: UInt64(sequenceStart), sequenceIndex: UInt64(index),
                    sequencePadWidth: sequencePadWidth)
                let duplicate = seen.contains(rendered)
                seen.insert(rendered)
                items.append(BatchRenamePreviewItem(
                    id: asset.id, oldFilename: full, newFilename: rendered, duplicate: duplicate))
            } catch {
                items.append(BatchRenamePreviewItem(
                    id: asset.id, oldFilename: full, error: error.localizedDescription))
            }
        }
        return items
    }

    /// Cloud preview — server-authoritative: it has the indexed EXIF
    /// `captured_at` this file never fetches locally, and its `duplicate`
    /// detection is the same code apply() will run against. Assets with no
    /// `stableID` (not yet indexed — same precondition the single-asset
    /// rename ticket's `renameUnsupportedReason` uses) are reported inline
    /// rather than sent to the server.
    private func renderCloudPreview() async -> [BatchRenamePreviewItem] {
        guard let cloudCatalog else {
            return assets.map {
                BatchRenamePreviewItem(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    error: "Not connected to the server.")
            }
        }
        let ids = assets.map { $0.stableID }
        let presentIDs = ids.compactMap { $0 }
        guard !presentIDs.isEmpty else {
            return assets.map {
                BatchRenamePreviewItem(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    error: "This photo hasn't finished indexing on the server yet.")
            }
        }
        do {
            let items = try await cloudCatalog.previewBatchRename(
                ids: presentIDs, template: template,
                sequenceStart: sequenceStart, sequencePadWidth: sequencePadWidth)
            let byID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
            return zip(assets, ids).map { asset, stableID in
                guard let stableID, let item = byID[stableID] else {
                    return BatchRenamePreviewItem(
                        id: asset.id, oldFilename: Self.fullFilename(asset),
                        error: "This photo hasn't finished indexing on the server yet.")
                }
                return BatchRenamePreviewItem(
                    id: asset.id, oldFilename: item.oldFilename ?? Self.fullFilename(asset),
                    newFilename: item.newFilename, error: item.error, duplicate: item.duplicate)
            }
        } catch {
            return assets.map {
                BatchRenamePreviewItem(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    error: error.localizedDescription)
            }
        }
    }

    // MARK: - Apply

    /// Refresh the preview once more (guards against a stale preview if the
    /// caller applies without having awaited a prior debounced refresh),
    /// then apply sequentially per routing. Always populates `applyResults`
    /// — including for `.unsupported` — so the sheet can show a per-file
    /// outcome list rather than a single pass/fail alert.
    public func apply() async {
        await refreshPreview()
        isApplying = true
        defer { isApplying = false }
        switch routing {
        case .unsupported(let reason):
            applyResults = assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0), outcome: .failed(reason))
            }
        case .filesystem:
            applyResults = await applyFilesystem()
        case .smb:
            applyResults = await applySMB()
        case .cloud:
            applyResults = await applyCloud()
        }
    }

    private func applyFilesystem() async -> [BatchRenameApplyResult] {
        var results: [BatchRenameApplyResult] = []
        results.reserveCapacity(assets.count)
        for (asset, item) in zip(assets, preview) {
            guard item.error == nil, let candidateName = item.newFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(item.error ?? "No rendered name.")))
                continue
            }
            guard candidateName != item.oldFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: candidateName)))
                continue
            }
            let newName = candidateName
            guard let url = asset.primaryURL else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed("This asset has no file on disk.")))
                continue
            }
            let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            do {
                let outcome = try await LocalFileOperations.relocate(
                    url, to: url.deletingLastPathComponent(), newBasename: newName,
                    mode: .move, collision: collision.localPolicy)
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: (outcome.primaryPath as NSString).lastPathComponent)))
            } catch FileOperationError.destinationExists where collision == .skip {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .skipped(reason: "A file with that name already exists.")))
            } catch {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(error.localizedDescription)))
            }
        }
        return results
    }

    private func applySMB() async -> [BatchRenameApplyResult] {
        guard let smbSource else {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed("SMB share is not connected."))
            }
        }
        var results: [BatchRenameApplyResult] = []
        results.reserveCapacity(assets.count)
        for (asset, item) in zip(assets, preview) {
            guard item.error == nil, let candidateName = item.newFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(item.error ?? "No rendered name.")))
                continue
            }
            guard candidateName != item.oldFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: candidateName)))
                continue
            }
            let newName = candidateName
            guard let mapleID = asset.stableID else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed("Missing SMB asset id.")))
                continue
            }
            let ref = ImageRef(id: mapleID, displayName: asset.displayName, url: nil)
            do {
                let newPath = try await smbSource.renameAsset(
                    ref, to: newName, collision: collision.localPolicy)
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: (newPath as NSString).lastPathComponent)))
            } catch FileOperationError.destinationExists where collision == .skip {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .skipped(reason: "A file with that name already exists.")))
            } catch {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(error.localizedDescription)))
            }
        }
        return results
    }

    /// One HTTP call for the whole batch — the server already applies
    /// sequentially (`batch-rename.ts`), so there is no per-asset loop here.
    private func applyCloud() async -> [BatchRenameApplyResult] {
        guard let cloudCatalog else {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed("Not connected to the server."))
            }
        }
        let ids = assets.map { $0.stableID }
        let presentIDs = ids.compactMap { $0 }
        guard !presentIDs.isEmpty else {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed("This photo hasn't finished indexing on the server yet."))
            }
        }
        do {
            let response = try await cloudCatalog.batchRename(
                ids: presentIDs, template: template, sequenceStart: sequenceStart,
                sequencePadWidth: sequencePadWidth, collision: collision.apiValue)
            let byID = Dictionary(uniqueKeysWithValues: response.results.map { ($0.id, $0) })
            return zip(assets, ids).map { asset, stableID in
                let old = Self.fullFilename(asset)
                guard let stableID else {
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .failed("This photo hasn't finished indexing on the server yet."))
                }
                guard let item = byID[stableID] else {
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .failed("No result returned by the server."))
                }
                switch item.kind {
                case "relocated":
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .renamed(newFilename: item.newFilename ?? old))
                case "skipped":
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .skipped(reason: item.reason ?? "collision"))
                default:
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .failed(item.error ?? "Rename failed (\(item.kind))."))
                }
            }
        } catch {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed(error.localizedDescription))
            }
        }
    }

    // MARK: - Helpers

    /// The full on-disk / catalog filename (stem + extension).
    /// `AssetRef.displayName` is inconsistent about including the
    /// extension — stripped for `primaryURL`-backed refs (Filesystem),
    /// included as-is for bytes-backed refs (SMB/Cloud/PhotoKit) — so this
    /// resolves the URL case explicitly rather than re-appending a guessed
    /// extension. Matches the single-asset rename ticket's identical helper.
    static func fullFilename(_ asset: AssetRef) -> String {
        if let url = asset.primaryURL {
            return url.lastPathComponent
        }
        return asset.displayName
    }

    static func splitStemExt(_ filename: String) -> (stem: String, ext: String) {
        let ns = filename as NSString
        let ext = ns.pathExtension
        let stem = ext.isEmpty ? filename : ns.deletingPathExtension
        return (stem, ext)
    }

    /// EXIF `DateTimeOriginal`, verbatim wire format, for `{date:FORMAT}`.
    /// Only available for file-backed (Filesystem) assets — a cheap
    /// metadata-only `ImageIO` read, no RAW decode. SMB assets render
    /// `nil` here deliberately: fetching EXIF over the network would mean
    /// downloading (part of) every selected file on every template edit,
    /// which this sheet's live-preview contract can't afford. The engine's
    /// documented fallback (`FALLBACK_DATE_TEXT`) covers this the same way
    /// it covers any file with no EXIF date at all — see
    /// `FilenameTemplateEngine.render`'s doc comment.
    private static func capturedAtExifString(for asset: AssetRef) -> String? {
        guard let url = asset.primaryURL else { return nil }
        return ImageMetadataReader.readRawCaptureDateStrings(from: url).dateTimeOriginal
    }
}
