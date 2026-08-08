// BatchRenameViewModel.swift — view model for the Batch Rename sheet
// (#2641, design doc § "Rename" — batch). Holds a snapshot of the selected
// assets and renders a live before→after preview through the shared
// `raw-core` template engine (`FilenameTemplateEngine`).
//
// Split across three files, each a self-contained concern:
//   • BatchRenameViewModel.swift (this file) — routing/collision/item
//     types, the class's stored state + init, `canApply`, and the preview
//     dispatcher (`refreshPreview`) + Cloud preview + shared name helpers.
//   • BatchRenameViewModel+CaptureDates.swift — the EXIF capture-date
//     cache (`captureDateReader`'s consumers): resolved off the main
//     actor, once, only when the template needs `{date:...}`. See that
//     file's header for the full reasoning.
//   • BatchRenameViewModel+Apply.swift — `apply()` and its three
//     per-source-kind paths (Filesystem / SMB / Cloud), applied
//     SEQUENTIALLY — a shared-destination template can collide with itself
//     mid-batch, not only with a pre-existing file, so each item must see
//     the PREVIOUS item's already-applied result before it renders/
//     resolves its own collision. Matches `library/batch-rename.ts`'s
//     contract exactly (its doc comment explains why `Promise.all` is
//     never used there; the same reasoning is why those apply loops are
//     plain sequential `for` loops, never a `TaskGroup`).
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
import OSLog

let batchRenameLog = Logger(subsystem: "app.justmaple.aperture", category: "BatchRenameViewModel")

/// Index a server response array by id, tolerating a duplicate id instead of
/// trapping (`Dictionary(uniqueKeysWithValues:)` crashes outright on one).
/// A duplicate is unexpected — either a caller-side duplicated selection or
/// a malformed server response — so "first wins" (deterministic: whichever
/// entry appeared first in `items`) is logged rather than silently accepted,
/// while still letting the batch proceed instead of crashing over it.
/// `internal` (not `private`) so `BatchRenameViewModelTests` can exercise
/// the duplicate-id path directly rather than only indirectly through a
/// mocked network call.
func indexByIDTolerantOfDuplicates<Item>(
    _ items: [Item], id: (Item) -> String
) -> [String: Item] {
    var seen = Set<String>()
    var out: [String: Item] = [:]
    out.reserveCapacity(items.count)
    for item in items {
        let key = id(item)
        if !seen.insert(key).inserted {
            batchRenameLog.error(
                "indexByIDTolerantOfDuplicates: duplicate id \(key, privacy: .public) in response — keeping the first entry")
            continue
        }
        out[key] = item
    }
    return out
}

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
    /// `internal` (not `private`) so `BatchRenameViewModel+Apply.swift` can
    /// read it.
    let smbSource: SMBSource?
    /// Live Cloud catalog client for `.cloud` routing. `nil` for every
    /// other routing. `internal` for the same cross-file reason as
    /// `smbSource`.
    let cloudCatalog: RemoteCatalog?

    public var template: String = "{original}"
    public var sequenceStart: Int = 1
    public var sequencePadWidth: Int = 0
    public var collision: BatchRenameCollisionChoice = .autoSuffix

    public internal(set) var preview: [BatchRenamePreviewItem]
    public private(set) var isPreviewing = false
    public internal(set) var isApplying = false
    public internal(set) var applyResults: [BatchRenameApplyResult]?

    /// Per-asset EXIF `DateTimeOriginal` (verbatim wire format), populated
    /// lazily by `ensureCapturedAtCacheIfNeeded`
    /// (`BatchRenameViewModel+CaptureDates.swift`) — see that method's doc
    /// for why this is a one-time, off-main-actor pass rather than a
    /// per-keystroke disk read. A present key with a `nil` value means
    /// "resolved, no EXIF date"; an absent key means "not yet resolved."
    /// `internal` so the CaptureDates extension file can read/write it.
    var capturedAtCache: [AssetRef.ID: String?] = [:]
    /// `true` once `ensureCapturedAtCacheIfNeeded` has run its one resolve
    /// pass over `assets` — guards against re-running it on a later
    /// `refreshPreview()` once a date token has ever appeared in the
    /// template. `assets` is a fixed snapshot for this view model's
    /// lifetime, so ONE pass permanently covers every asset; there is never
    /// a reason to re-resolve. `internal` for the same reason as
    /// `capturedAtCache`.
    var capturedAtCachePopulated = false

    /// Reads a file-backed asset's EXIF `DateTimeOriginal` for the
    /// `{date:FORMAT}` token. `@Sendable` and swappable (not just for
    /// tests — any future caller that wants a different resolution
    /// strategy can inject one) because `ensureCapturedAtCacheIfNeeded`
    /// calls it from inside a `TaskGroup`, off the main actor. Defaults to
    /// `ImageMetadataReader.readRawCaptureDateStrings` — a metadata-only
    /// `ImageIO` read, no RAW decode.
    public var captureDateReader: @Sendable (URL) -> String? = { url in
        ImageMetadataReader.readRawCaptureDateStrings(from: url).dateTimeOriginal
    }

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
    /// keystroke for Filesystem/SMB (pure string logic; the one disk-I/O
    /// cost — EXIF capture-date resolution — is paid at most ONCE per
    /// view model, off the main actor, and only when the template actually
    /// uses `{date:...}`, via `ensureCapturedAtCacheIfNeeded`); Cloud
    /// debounces at the call site since it's a network round trip — see
    /// `BatchRenameSheet`.
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
            // Populated (if needed at all) and fully AWAITED before
            // rendering below — the preview is never computed against a
            // half-resolved cache, so it can't show a stale/wrong date for
            // some assets and a correct one for others within one render.
            await ensureCapturedAtCacheIfNeeded(for: template)
            preview = Self.renderLocalPreview(
                assets: assets, template: template,
                sequenceStart: sequenceStart, sequencePadWidth: sequencePadWidth,
                capturedAtCache: capturedAtCache)
        case .cloud:
            preview = await renderCloudPreview()
        }
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
            let byID = indexByIDTolerantOfDuplicates(items, id: \.id)
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
}
