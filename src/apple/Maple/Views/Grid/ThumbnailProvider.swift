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

/// Facade actor. `PhotoThumbnailCell` calls `thumbnail(for:targetSize:)` and
/// gets JPEG bytes back regardless of which backend served them.
///
/// Inject once per grid surface (same lifetime as the owning view model) and
/// share it across all cells in that grid. The actor serialises concurrent
/// requests through `CloudThumbClient` so the cloud connection is not
/// hammered; the PhotoKit and ThumbnailLoader paths are independently
/// concurrent.
actor ThumbnailProvider {

    // MARK: - Dependencies

    private let thumbClient: CloudThumbClient
    private let thumbCache: CloudThumbCache
    private let host: String

    // MARK: - Init

    /// Create a provider wired to the cloud-thumb infrastructure.
    ///
    /// - Parameters:
    ///   - thumbClient: Cloud thumb fetcher (from the timeline's existing wiring).
    ///   - thumbCache:  Disk cache for cloud thumbs (same instance the timeline uses).
    ///   - host:        Server cache-host key (`vm.server.cacheHostKey`).
    init(thumbClient: CloudThumbClient, thumbCache: CloudThumbCache, host: String) {
        self.thumbClient = thumbClient
        self.thumbCache = thumbCache
        self.host = host
    }

    // MARK: - Public API

    /// Load JPEG thumbnail bytes for `source`, returning `nil` on any failure.
    /// The caller (`PhotoThumbnailCell`) drives this from a `.task(id: item.id)`
    /// so the load is automatically cancelled when the cell disappears.
    ///
    /// Target sizes follow the conventions established by the original cells:
    ///   - cloud: 512 px (CloudThumbClient's default)
    ///   - local: 256 px (ThumbnailDiskCache.defaultThumbSize)
    ///   - PhotoKit: ThumbnailDiskCache.defaultThumbSize (Photos' own cache)
    func thumbnail(for source: ThumbnailSource, targetSize: Int = 256) async -> Data? {
        let backend = source.resolvedBackend()
        switch backend {
        case .thumbnailLoader(let ref, let box):
            return await ThumbnailLoader.shared.load(for: ref, from: box?.source)

        case .cloudThumb(let absPath, let host):
            return await Self.fetchCloudThumb(
                host: host,
                absPath: absPath,
                cache: thumbCache,
                client: thumbClient,
                size: 512
            )

        case .photoKit(let localID):
            return await Self.fetchPhotoKitThumb(localID: localID)
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
    /// Preview provider that never makes network or Photos requests.
    /// Returns `nil` for every load — cells show the placeholder.
    static func preview() -> ThumbnailProvider {
        ThumbnailProvider(
            thumbClient: CloudThumbClient.preview(),
            thumbCache: CloudThumbCache.preview(),
            host: "preview"
        )
    }
}
