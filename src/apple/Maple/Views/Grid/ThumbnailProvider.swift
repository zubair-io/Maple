// ThumbnailProvider.swift — single load facade for all photo-grid surfaces.
//
// Part of the grid-unify refactor (#1490 M0). Absorbs the thumbnail-load
// logic currently duplicated across:
//   - BrowseGrid.MergedCellView  (PhotoKit fast path + JPEG encode)
//   - CloudTimelineMergedCell    (PhotoKit fast path + JPEG encode)
//   - CloudTimelineCell          (cloud fetch + cache)
//
// One entry point — `thumbnail(for:targetSize:) async -> Data?` — dispatches
// to the appropriate backend based on `ThumbnailSource`. No new caching layers
// are added: the actor orchestrates the EXISTING caches (ThumbnailDiskCache via
// ThumbnailLoader, CloudThumbCache, Photos' own preview cache).
//
// PHImageManager lives in Photos.framework, so this file is app-side
// (Maple target, NOT MapleCore) even though the model types are in MapleCore.

import SwiftUI
import MapleCore
import Photos
import ImageIO
import UniformTypeIdentifiers
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - ThumbnailProvider

/// Facade actor. `PhotoThumbnailCell` calls `thumbnail(for:)` and gets JPEG
/// bytes back regardless of which backend served them.
///
/// Inject once per grid surface (same lifetime as the owning view model) and
/// share it across all cells in that grid. This actor is a thin dispatcher: it
/// does NOT add coalescing or throttling. `ThumbnailLoader` already coalesces
/// in-flight local requests; the cloud/PhotoKit paths inherit whatever
/// concurrency their callers drive (one `.task` per visible cell).
actor ThumbnailProvider {

    // MARK: - Dependencies

    private let thumbClient: CloudThumbClient?
    private let thumbCache: CloudThumbCache?

    // MARK: - Init

    /// Create a provider optionally wired to cloud-thumb infrastructure.
    ///
    /// Pass `nil` for both parameters when the grid is local-only (LibraryGrid,
    /// BrowseGrid local sources) — cloud branches return `nil` in that case,
    /// which is correct because a local grid never dispatches `.cloud` or
    /// `.merged(.cloudOnly)` sources anyway.
    ///
    /// The cloud host travels with each `ThumbnailSource` (`.cloud`/`.merged`
    /// carry it), so it is not stored here — one source of truth.
    ///
    /// The two cloud deps must be wired together: pass BOTH or NEITHER. A partial
    /// configuration would silently make every cloud thumb return `nil` (the cloud
    /// branch needs both the client and the cache), so it's asserted against.
    ///
    /// - Parameters:
    ///   - thumbClient: Cloud thumb fetcher (from the timeline's existing wiring).
    ///   - thumbCache:  Disk cache for cloud thumbs (same instance the timeline uses).
    init(thumbClient: CloudThumbClient? = nil, thumbCache: CloudThumbCache? = nil) {
        assert(
            (thumbClient == nil) == (thumbCache == nil),
            "ThumbnailProvider cloud deps must be wired together — pass both or neither"
        )
        self.thumbClient = thumbClient
        self.thumbCache = thumbCache
    }

    /// Convenience for local-only grid surfaces that need no cloud infrastructure.
    static func local() -> ThumbnailProvider {
        ThumbnailProvider()
    }

    // MARK: - Public API

    /// Load JPEG thumbnail bytes for `source`, returning `nil` on any failure.
    /// The caller (`PhotoThumbnailCell`) drives this from a `.task(id: item.id)`
    /// so the load is automatically cancelled when the cell disappears.
    ///
    /// Each backend keeps its established target size (no caller override — the
    /// cloud cache is keyed without size, so a per-call size wouldn't be honoured):
    ///   - cloud:    512 px (CloudThumbClient's default)
    ///   - local:    ThumbnailLoader's own sizing (256 px disk cache)
    ///   - PhotoKit: ThumbnailDiskCache.defaultThumbSize (Photos' own cache)
    func thumbnail(for source: ThumbnailSource) async -> Data? {
        let backend = source.resolvedBackend()
        switch backend {
        case .thumbnailLoader(let ref, let box):
            return await ThumbnailLoader.shared.load(for: ref, from: box?.source)

        case .cloudThumb(let absPath, let host):
            guard let cache = thumbCache, let client = thumbClient else { return nil }
            return await Self.fetchCloudThumb(
                host: host,
                absPath: absPath,
                cache: cache,
                client: client,
                size: 512
            )

        case .photoKit(let localID):
            return await Self.fetchPhotoKitThumb(localID: localID)
        }
    }

    /// Lazily load a display-sized image after the fast thumbnail is visible.
    /// This deliberately bypasses the thumbnail caches: those are keyed for
    /// grid-sized pixels and must never be polluted with a larger variant.
    ///
    /// Per-backend display tier:
    ///   - local URL-backed: `.maple/previews/<key>_1600.jpg` next to the
    ///     asset via `ThumbnailLoader.loadDisplayPreview` (generated from the
    ///     embedded camera preview on first request).
    ///   - sourceless local (cloud/self-hosted browse): the source's own
    ///     `preview(for:)` — `CloudSource` serves the server-generated
    ///     1280 px `/api/fs/preview` artifact.
    ///   - cloud timeline: `CloudThumbClient.preview` → the same
    ///     `/api/fs/preview` tier. (NOT `thumb(size:)` — the server keeps one
    ///     mtime-checked thumb file per RAW, so a larger `size` request just
    ///     returns the cached 512 px grid thumb.)
    ///   - PhotoKit: `PHImageManager` high-quality request at `maxDimension`.
    func preview(for source: ThumbnailSource, maxDimension: CGFloat = 2_048) async -> Data? {
        switch source.resolvedBackend() {
        case .thumbnailLoader(let ref, let box):
            if ref.primaryURL != nil {
                return await ThumbnailLoader.shared.loadDisplayPreview(for: ref)
            }
            guard let imageSource = box?.source else { return nil }
            let imageRef = ImageRef(
                id: ref.stableID ?? ref.id.uuidString,
                displayName: ref.displayName,
                url: nil,
                scopeParentURL: ref.scopeParentURL
            )
            return try? await imageSource.preview(for: imageRef)
        case .cloudThumb(let absPath, _):
            guard let client = thumbClient else { return nil }
            return try? await client.preview(absPath: absPath)
        case .photoKit(let localID):
            return await Self.fetchPhotoKitPreview(
                localID: localID,
                maxDimension: maxDimension
            )
        }
    }

    // MARK: - Synchronous cache peek (M1 scale-zoom)

    /// Synchronous, non-awaiting peek into the in-memory thumbnail cache.
    /// Returns JPEG bytes only when the thumbnail is already hot in memory;
    /// returns `nil` on any miss without blocking or doing I/O.
    ///
    /// Backed by `ThumbnailDiskCache.syncPeekCache` (an `NSCache`, thread-safe).
    /// Only effective for `.local` and `.photoKit` sources loaded through
    /// `ThumbnailLoader` / `ThumbnailDiskCache` — cloud thumbs (routed through
    /// `CloudThumbCache`) always return `nil` here.
    ///
    /// Key derivation mirrors `ThumbnailLoader.load(for:from:)`:
    ///   - URL-backed local assets: the asset filename (basename).
    ///   - Sourceless assets (PhotoKit, stableID-only): `stableID ?? displayName`.
    nonisolated func cachedThumbnail(for source: ThumbnailSource) -> Data? {
        let backend = source.resolvedBackend()
        switch backend {
        case .thumbnailLoader(let ref, _):
            let key = ref.primaryURL?.lastPathComponent
                ?? ref.stableID
                ?? ref.displayName
            return ThumbnailDiskCache.shared.syncPeekData(forKey: key)
        case .photoKit(let localID):
            return ThumbnailDiskCache.shared.syncPeekData(forKey: localID)
        case .cloudThumb:
            return nil   // cloud cache not synchronously peekable
        }
    }
}

// MARK: - Cloud thumb fetch + cache

private extension ThumbnailProvider {
    /// Cloud thumb fetch with cache. Exact behaviour from `CloudTimelineCell.fetchThumbBytes`.
    static func fetchCloudThumb(
        host: String,
        absPath: String,
        cache: CloudThumbCache,
        client: CloudThumbClient,
        size: Int
    ) async -> Data? {
        if let cached = await cache.get(host: host, absPath: absPath) {
            return cached
        }
        do {
            let bytes = try await client.thumb(absPath: absPath, size: size)
            await cache.put(host: host, absPath: absPath, bytes)
            return bytes
        } catch {
            return nil
        }
    }
}

// MARK: - PhotoKit fast path

private extension ThumbnailProvider {
    /// PHImageManager fast path — Photos' preview cache makes this ~5–50 ms.
    ///
    /// Hoisted verbatim from `CloudTimelineMergedCell.fetchPhotoKitThumb`
    /// (CloudTimelineView.swift). One copy here; both old cells will delegate
    /// here in M1/M2. The `Latch` pattern prevents the completion handler from
    /// resuming the continuation twice (Photos can call back multiple times for
    /// opportunistic delivery).
    static func fetchPhotoKitThumb(localID: String) async -> Data? {
        guard let phAsset = PHAsset
            .fetchAssets(withLocalIdentifiers: [localID], options: nil)
            .firstObject else { return nil }

        let target = ThumbnailDiskCache.defaultThumbSize
        return await withCheckedContinuation { cont in
            let options = PHImageRequestOptions()
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = true
            options.isSynchronous = false

            final class Latch: @unchecked Sendable {
                let lock = NSLock(); var fired = false
                func tryFire() -> Bool {
                    lock.lock(); defer { lock.unlock() }
                    if fired { return false }; fired = true; return true
                }
            }
            let latch = Latch()

            PHImageManager.default().requestImage(
                for: phAsset,
                targetSize: target,
                contentMode: .aspectFill,
                options: options
            ) { image, info in
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                guard latch.tryFire() else { return }
                guard let image else { cont.resume(returning: nil); return }
                cont.resume(returning: jpegBytes(from: image))
            }
        }
    }

    static func fetchPhotoKitPreview(localID: String, maxDimension: CGFloat) async -> Data? {
        guard let phAsset = PHAsset
            .fetchAssets(withLocalIdentifiers: [localID], options: nil)
            .firstObject else { return nil }

        return await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .exact
            options.isNetworkAccessAllowed = true
            options.isSynchronous = false

            // High-quality requests normally call back once, but guard the
            // continuation defensively so cancellation or an unexpected
            // second callback can never hang or trap the awaiting task.
            final class Latch: @unchecked Sendable {
                let lock = NSLock(); var fired = false
                func tryFire() -> Bool {
                    lock.lock(); defer { lock.unlock() }
                    if fired { return false }; fired = true; return true
                }
            }
            let latch = Latch()

            PHImageManager.default().requestImage(
                for: phAsset,
                targetSize: CGSize(width: maxDimension, height: maxDimension),
                contentMode: .aspectFit,
                options: options
            ) { image, info in
                guard latch.tryFire() else { return }
                guard (info?[PHImageCancelledKey] as? Bool) != true,
                      (info?[PHImageErrorKey] as? Error) == nil,
                      let image
                else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: jpegBytes(from: image))
            }
        }
    }

    /// Encode a platform image to JPEG bytes. Exact params from both originals:
    /// `kCGImageDestinationLossyCompressionQuality: ThumbnailDiskCache.jpegQuality` (0.82).
    static func jpegBytes(from image: PlatformImage) -> Data? {
        #if canImport(AppKit)
        var rect = CGRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
        else { return nil }
        #elseif canImport(UIKit)
        guard let cg = image.cgImage else { return nil }
        #endif
        let mutableData = NSMutableData()
        let type = UTType.jpeg.identifier as CFString
        guard let dest = CGImageDestinationCreateWithData(mutableData, type, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(
            dest, cg,
            [kCGImageDestinationLossyCompressionQuality: ThumbnailDiskCache.jpegQuality]
                as CFDictionary
        )
        return CGImageDestinationFinalize(dest) ? (mutableData as Data) : nil
    }
}

// MARK: - Preview support

extension ThumbnailProvider {
    /// Provider for SwiftUI `#Preview`s: a local-only provider (no cloud deps,
    /// so it never hits the network). Preview items use bogus ids, so `.photoKit`
    /// finds no `PHAsset` and `.local` has no bytes — every load resolves to `nil`
    /// and cells render the placeholder. (It is not a hard stub; it simply has
    /// nothing real to load in a preview.)
    static func preview() -> ThumbnailProvider {
        ThumbnailProvider()
    }
}
