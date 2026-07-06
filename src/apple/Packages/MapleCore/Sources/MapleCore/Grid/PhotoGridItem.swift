// PhotoGridItem.swift — unified value model for every photo-grid surface.
//
// Part of the grid-unify refactor (#1490 M0). Five new shared components
// replace four near-duplicate grid/cell implementations. Each surface maps
// its DTO → PhotoGridItem; PhotoThumbnailCell renders it via ThumbnailProvider.
//
// Design: docs/superpowers/specs/2026-06-24-unify-photo-grids-design.md
//
// Note on Hashable: ThumbnailSource intentionally does NOT conform to Hashable
// because the `.local` case carries `(any ImageSource)?` — an existential
// backed by an actor protocol — which is not Hashable. PhotoGridItem equality
// compares `id` + `overlays` so SwiftUI re-renders a cell when its badges change
// (rating/flag/sync) under a stable id; `hash(into:)` stays `id`-only (a same-id,
// different-overlays hash collision is permitted by the Hashable contract).

import Foundation

// MARK: - ImageSourceBox

/// Sendable wrapper for an `(any ImageSource)?` value so it can be stored in
/// a `Sendable` enum without triggering Swift 6 isolation errors. The box
/// does NOT participate in equality or hashing (the surrounding PhotoGridItem
/// hashes on `id` only).
public struct ImageSourceBox: @unchecked Sendable {
    public let source: (any ImageSource)?

    public init(_ source: (any ImageSource)?) {
        self.source = source
    }
}

// MARK: - ThumbnailSource

/// Which backend loads the thumbnail for a grid item. Maps 1:1 onto the three
/// existing load backends; the `.merged` case resolves to one of the others
/// depending on cell state.
public enum ThumbnailSource: Sendable {
    /// Local filesystem asset — routes through `ThumbnailLoader.shared`.
    case local(AssetRef, source: ImageSourceBox?)
    /// Cloud-only asset — routes through `CloudThumbClient` + `CloudThumbCache`.
    case cloud(absPath: String, host: String)
    /// PhotoKit asset — routes through `PHImageManager` fast path.
    case photoKit(localID: String)
    /// Merged PhotoKit + Cloud cell — resolved to `photoKit` or `cloud`
    /// depending on the cell's sync state (.synced/.localOnly → photoKit;
    /// .cloudOnly → cloud).
    case merged(MergedTimelineCell, host: String)
}

// MARK: - SyncBadge

/// Indicates whether a merged-timeline cell is fully synced, cloud-only,
/// or local-only (awaiting upload). Maps to the badge icons rendered by
/// `CloudTimelineMergedCell` / `BrowseGrid.MergedCellView`.
public enum SyncBadge: Sendable, Hashable {
    case synced
    case cloudOnly
    case localOnly
}

// MARK: - OverlayStyle

/// Controls which badge layout variant `GridCellOverlayView` renders.
///
/// - `.phone`   — S2 phone spec: green pick dot top-left, ≥4★ gold bottom-left.
/// - `.desktop` — iPad/Mac chrome: `FlagBadge` + `StarView` row bottom-leading.
/// - `.cloud`   — Cloud-timeline cells: rating stars top-leading (yellow, caption2),
///               regardless of sync-badge presence. Use for cloud-only `SearchAsset`
///               cells where `sync == nil` but rating still appears at top-leading.
public enum OverlayStyle: Sendable, Hashable {
    case phone
    case desktop
    case cloud
}

// MARK: - GridCellOverlays

/// All the badge/state data a `PhotoThumbnailCell` needs to render its overlay
/// layer. Separated from `ThumbnailSource` so the cell can be driven purely
/// from value data without knowing about the load backend.
public struct GridCellOverlays: Sendable, Hashable {
    /// Star rating 0..5. `0` means unrated.
    public var rating: Int = 0
    /// Pick / reject flag. `nil` means no flag (same as `.none` on `CullFlag`).
    public var flag: CullFlag? = nil
    /// Sync state badge for merged timeline cells. `nil` for local-only grids.
    public var sync: SyncBadge? = nil
    /// True when the asset is a video — reserved for a video-indicator badge.
    public var isVideo: Bool = false
    /// Phone vs. desktop badge layout.
    public var style: OverlayStyle = .phone
    /// True when `CullingState.hidden == true` — dims the thumbnail and shows
    /// the "HIDDEN" badge (see `PhotoThumbnailCell`).
    public var hidden: Bool = false

    public init(
        rating: Int = 0,
        flag: CullFlag? = nil,
        sync: SyncBadge? = nil,
        isVideo: Bool = false,
        style: OverlayStyle = .phone,
        hidden: Bool = false
    ) {
        self.rating = rating
        self.flag = flag
        self.sync = sync
        self.isVideo = isVideo
        self.style = style
        self.hidden = hidden
    }
}

// MARK: - PhotoGridItem

/// Unified grid item. Every surface converts its DTO to a `PhotoGridItem`;
/// `PhotoThumbnailCell` and `ThumbnailProvider` only know this type.
///
/// `id` is the stable grid identity used as the SwiftUI `.task(id:)` token,
/// the selection key, and the zoom-transition tag (`matchedTransitionSource`).
/// `displayName` is the human-readable asset name used for the per-cell
/// accessibility identifier (`"thumb-<displayName>"`) that the UITest harness
/// resolves — e.g. `app.otherElements["thumb-test_0017"]`. LibraryCell carried
/// this as `asset.displayName`; the shared cell restores it via this field.
public struct PhotoGridItem: Identifiable, Sendable {
    public let id: String
    /// Human-readable name used for `.accessibilityIdentifier("thumb-\(displayName)")`.
    public let displayName: String
    public let thumbnailSource: ThumbnailSource
    public var overlays: GridCellOverlays

    public init(
        id: String,
        displayName: String,
        thumbnailSource: ThumbnailSource,
        overlays: GridCellOverlays = .init()
    ) {
        self.id = id
        self.displayName = displayName
        self.thumbnailSource = thumbnailSource
        self.overlays = overlays
    }
}

// MARK: - Hashable conformance (id-based)

extension PhotoGridItem: Hashable {
    public static func == (lhs: PhotoGridItem, rhs: PhotoGridItem) -> Bool {
        lhs.id == rhs.id && lhs.overlays == rhs.overlays
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

// MARK: - Per-surface adapters

extension PhotoGridItem {

    // MARK: Local asset adapter

    /// Maps a local `AssetRef` to a `PhotoGridItem`. Uses `stableID` as the
    /// grid identity (falls back to UUID string when stableID is nil — those
    /// items won't match across grid reloads, which is acceptable for url-less
    /// sourceless refs where no stable cross-session id is available).
    ///
    /// - Parameters:
    ///   - asset: The local asset reference.
    ///   - source: The image source the asset came from (PhotoKit, SMB, …).
    ///   - overlays: Pre-built overlay state (rating, flag, style).
    public init(local asset: AssetRef, source: (any ImageSource)?, overlays: GridCellOverlays) {
        let stableID = asset.stableID ?? asset.id.uuidString
        self.init(
            id: stableID,
            displayName: asset.displayName,
            thumbnailSource: .local(asset, source: ImageSourceBox(source)),
            overlays: overlays
        )
    }

    // MARK: Cloud asset adapter

    /// Maps a `SearchAsset` (cloud DTO) to a `PhotoGridItem`.
    ///
    /// Flag mapping: `SearchAsset.flag` is `Int?` where 1 = pick, -1 = reject,
    /// 0 / nil = none. Values outside {-1, 0, 1} are treated as none.
    ///
    /// - Parameters:
    ///   - asset: The cloud search result.
    ///   - host: The server's cache-host key (from `vm.server.cacheHostKey`).
    ///   - style: Badge layout for this surface.
    public init(cloud asset: SearchAsset, host: String, style: OverlayStyle) {
        let flag: CullFlag? = {
            switch asset.flag {
            case 1:  return .pick
            case -1: return .reject
            default: return nil
            }
        }()
        let overlays = GridCellOverlays(
            rating: asset.rating ?? 0,
            flag: flag,
            sync: nil,
            isVideo: false,
            style: style
        )
        self.init(
            id: asset.id,
            displayName: asset.filename,
            thumbnailSource: .cloud(absPath: asset.abs_path, host: host),
            overlays: overlays
        )
    }

    // MARK: Merged timeline cell adapter

    /// Maps a `MergedTimelineCell` to a `PhotoGridItem`. The cell's sync state
    /// is encoded as a `SyncBadge` in the overlays; the `ThumbnailProvider`
    /// resolves `.merged` to the correct backend at load time.
    ///
    /// - Parameters:
    ///   - cell: The merged cell from `MergedTimelineSource.merge`.
    ///   - host: The server's cache-host key (needed by `ThumbnailProvider`
    ///     to route `.cloudOnly` cells to `CloudThumbClient`).
    ///   - sync: The badge state for this cell.
    ///   - style: Badge layout for this surface.
    public init(merged cell: MergedTimelineCell, host: String, sync: SyncBadge, style: OverlayStyle) {
        let id = MergedTimelineSource.renderID(cell)
        let displayName = MergedTimelineSource.displayName(cell)
        let overlays = GridCellOverlays(
            rating: 0,
            flag: nil,
            sync: sync,
            isVideo: false,
            style: style
        )
        self.init(
            id: id,
            displayName: displayName,
            thumbnailSource: .merged(cell, host: host),
            overlays: overlays
        )
    }
}

// MARK: - ThumbnailSource.Backend (pure routing helper)

extension ThumbnailSource {
    /// Pure enum describing which concrete backend will serve a thumbnail.
    /// Used by `ThumbnailProvider` and unit tests — the actual I/O lives in
    /// the provider; this helper is testable without Photos or network.
    public enum Backend: Sendable, Equatable {
        case thumbnailLoader(AssetRef, source: ImageSourceBox?)
        case cloudThumb(absPath: String, host: String)
        case photoKit(localID: String)

        public static func == (lhs: Backend, rhs: Backend) -> Bool {
            switch (lhs, rhs) {
            case (.thumbnailLoader(let la, _), .thumbnailLoader(let ra, _)):
                return la == ra
            case (.cloudThumb(let lp, let lh), .cloudThumb(let rp, let rh)):
                return lp == rp && lh == rh
            case (.photoKit(let lid), .photoKit(let rid)):
                return lid == rid
            default:
                return false
            }
        }
    }

    /// Resolve a `ThumbnailSource` to the concrete backend that will serve it.
    /// For `.merged` cells:
    ///   - `.synced` / `.localOnly` → `photoKit` using the local `ImageRef.id`
    ///   - `.cloudOnly`            → `cloudThumb` using the cloud ref's `abs_path`
    ///
    /// This is the pure routing logic extracted from `ThumbnailProvider` so it
    /// can be unit-tested without any I/O.
    public func resolvedBackend() -> Backend {
        switch self {
        case .local(let ref, let box):
            return .thumbnailLoader(ref, source: box)
        case .cloud(let absPath, let host):
            return .cloudThumb(absPath: absPath, host: host)
        case .photoKit(let localID):
            return .photoKit(localID: localID)
        case .merged(let cell, let host):
            switch cell {
            case .synced(let local, _), .localOnly(let local):
                return .photoKit(localID: local.id)
            case .cloudOnly(let cloudRef):
                // The cloud ref id is "fs:<abs_path>" — extract via the VM helper
                // convention. We replicate the extraction logic here to keep this
                // pure type free of any CloudTimelineViewVM dependency.
                let absPath: String
                if cloudRef.id.hasPrefix("fs:") {
                    absPath = String(cloudRef.id.dropFirst(3))
                } else {
                    absPath = cloudRef.id
                }
                return .cloudThumb(absPath: absPath, host: host)
            }
        }
    }
}
