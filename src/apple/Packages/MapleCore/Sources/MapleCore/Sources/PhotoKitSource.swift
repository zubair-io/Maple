// PhotoKitSource.swift — PHFetchResult-based source adapter.
//
// Holds a live `PHFetchResult<PHAsset>` (lazy, SQLite-backed) rather than an
// eager `[PhotoKitAsset]` array. `fetchAssets(for:)` returns as soon as Photos
// has run the predicate — no per-asset enumeration, no per-asset
// `PHAssetResource.assetResources(for:)` calls. On a 100k-image library the
// prior eager-filter path blocked the main loader for minutes because each
// RAW-extension check hit Photos.sqlite; the new path is effectively O(1).
//
// Tradeoff: we no longer filter to "RAW-only" at fetch time. The grid surfaces
// every image in the container; the RAW decoder at open time is where
// non-RAW is rejected (or handled, once we support opening JPEG/HEIF).
//
// RAW bytes: PHImageRequestOptions with PHImageRequestOptionsVersion.unadjusted
// and allowNetworkAccess=false to get the full RAW buffer for the Rust
// pipeline.

import Foundation
import CoreGraphics
import ImageIO
import Photos
import UniformTypeIdentifiers

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - PhotoKitSource

/// Browses a filtered view of the user's Photo Library.
public actor PhotoKitSource {

    // MARK: State

    private var fetchResult: PHFetchResult<PHAsset>?
    private var authStatus: PHAuthorizationStatus = .notDetermined

    /// O(1). Backed by the PHFetchResult count (SQLite `COUNT(*)` on the
    /// predicate, not an array length).
    public var count: Int { fetchResult?.count ?? 0 }

    public init() {}

    // MARK: Public API

    /// Request Photo Library authorization and fetch the "all images" view.
    /// Throws `PhotoKitError.accessDenied` if permission is not granted.
    public func requestAccessAndFetch() async throws {
        try await fetchAssets(for: .all)
    }

    /// Configure the source to apply `filter`. Access is (re)requested here
    /// so first-time callers still see the permission prompt. Returns as
    /// soon as PhotoKit has run the predicate — no iteration of the result.
    public func fetchAssets(for filter: PhotoKitFilter) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        authStatus = status
        guard status == .authorized || status == .limited else {
            throw PhotoKitError.accessDenied(status)
        }
        fetchResult = Self.buildFetchResult(for: filter)
    }

    /// Build the PHFetchResult for the requested filter. No enumeration —
    /// `PHAsset.fetchAssets` itself is SQLite-backed and lazy; accessing
    /// `.count` or iterating only materializes PHAsset proxies on demand.
    private static func buildFetchResult(for filter: PhotoKitFilter) -> PHFetchResult<PHAsset> {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]

        switch filter {
        case .all:
            return PHAsset.fetchAssets(with: .image, options: options)
        case .favorites:
            options.predicate = NSPredicate(format: "favorite == YES")
            return PHAsset.fetchAssets(with: .image, options: options)
        case .picks, .rejects:
            // maple:flag lives in XMP sidecars, not PHAsset metadata. Surface
            // the full image set here; the VM layer can apply the flag
            // predicate once sidecars are loaded.
            return PHAsset.fetchAssets(with: .image, options: options)
        case .album(let id, _):
            let collectionResult = PHAssetCollection.fetchAssetCollections(
                withLocalIdentifiers: [id], options: nil
            )
            guard let collection = collectionResult.firstObject else {
                // Synthesize an empty result — impossible predicate.
                let empty = PHFetchOptions()
                empty.predicate = NSPredicate(value: false)
                return PHAsset.fetchAssets(with: .image, options: empty)
            }
            return PHAsset.fetchAssets(in: collection, options: options)
        }
    }

    /// Look up a PHAsset by its `localIdentifier` (the opaque id we hand out
    /// in `ImageRef.id`). Photos re-vends a fresh proxy — we don't need to
    /// hold onto them across calls.
    private func phAsset(for localID: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [localID], options: nil).firstObject
    }

    /// Fetch the raw image bytes for an asset by localIdentifier (for the
    /// Rust pipeline). Returns nil if the asset is not available locally.
    public func rawData(for localID: String) async -> Data? {
        guard let phAsset = phAsset(for: localID) else { return nil }
        return await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.version = .unadjusted
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = false
            options.isSynchronous = false

            PHImageManager.default().requestImageDataAndOrientation(
                for: phAsset,
                options: options
            ) { data, _, _, _ in
                continuation.resume(returning: data)
            }
        }
    }

    /// Request a thumbnail for the given PHAsset via PhotoKit and return JPEG
    /// bytes encoded at the spec-mandated quality (q = 0.82). The request is
    /// keyed at the spec thumbnail size (256 px long edge) — Photos already
    /// keeps a low-res preview cache, so this is roughly 5–50 ms per image
    /// versus 300–500 ms for a full Rust develop.
    ///
    /// Multi-resume guard: `.opportunistic` delivery mode fires the result
    /// handler twice (degraded preview, then final). We resume the
    /// continuation exactly once on the final, non-degraded callback.
    public func thumbData(for localID: String) async -> Data? {
        guard let phAsset = phAsset(for: localID) else { return nil }
        let target = ThumbnailDiskCache.defaultThumbSize

        let platformImage: PlatformImage? = await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.version = .current
            options.deliveryMode = .opportunistic
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = true
            options.isSynchronous = false

            // Resume-latch — `.opportunistic` calls the handler at least
            // twice (low-res, then hi-res). Resuming a continuation more
            // than once is a fatal trap.
            final class ResumeLatch: @unchecked Sendable {
                private var resumed = false
                private let lock = NSLock()
                func tryResume() -> Bool {
                    lock.lock(); defer { lock.unlock() }
                    if resumed { return false }
                    resumed = true
                    return true
                }
            }
            let latch = ResumeLatch()

            PHImageManager.default().requestImage(
                for: phAsset,
                targetSize: target,
                contentMode: .aspectFill,
                options: options
            ) { image, info in
                // Errored or cancelled — final callback, latch and bail.
                if (info?[PHImageErrorKey] as? Error) != nil
                    || (info?[PHImageCancelledKey] as? Bool) == true {
                    if latch.tryResume() { continuation.resume(returning: nil) }
                    return
                }
                // Skip the degraded preview — wait for the hi-res result.
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true {
                    return
                }
                // Final, non-degraded result.
                guard latch.tryResume() else { return }
                continuation.resume(returning: image)
            }
        }

        guard let image = platformImage else { return nil }
        return Self.jpegBytes(from: image)
    }

    // MARK: - JPEG encoding

    /// Encode a platform image (NSImage on macOS, UIImage on iOS/iPadOS) to
    /// JPEG bytes at the spec quality (`ThumbnailDiskCache.jpegQuality`). The
    /// CGImage path goes through ImageIO so both platforms share the same
    /// encoder behaviour.
    private static func jpegBytes(from image: PlatformImage) -> Data? {
        guard let cg = cgImage(from: image) else { return nil }
        let data = NSMutableData()
        let type = (UTType.jpeg.identifier as CFString)
        guard let dest = CGImageDestinationCreateWithData(data, type, 1, nil) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: ThumbnailDiskCache.jpegQuality
        ]
        CGImageDestinationAddImage(dest, cg, options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    private static func cgImage(from image: PlatformImage) -> CGImage? {
        #if canImport(UIKit)
        return image.cgImage
        #elseif canImport(AppKit)
        var rect = CGRect(origin: .zero, size: image.size)
        return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
        #else
        return nil
        #endif
    }
}

// MARK: - PlatformImage

/// Cross-platform alias so the thumb pipeline doesn't fork on `#if` per call.
/// `PHImageManager.requestImage` returns `UIImage?` on UIKit platforms and
/// `NSImage?` on AppKit.
#if canImport(UIKit)
private typealias PlatformImage = UIImage
#elseif canImport(AppKit)
private typealias PlatformImage = NSImage
#endif

// MARK: - ImageSource conformance

extension PhotoKitSource: ImageSource {
    /// Enumerate the fetch result building ImageRefs. Uses the asset's
    /// `localIdentifier` as both `id` and `displayName` — resolving the true
    /// filename requires `PHAssetResource.assetResources(for:)` which runs
    /// one SQLite query per asset and takes minutes on large libraries.
    /// Consumers that need the file basename/extension look it up lazily
    /// when the asset is actually opened (see `rawBytes(for:)`).
    public func images() async throws -> [ImageRef] {
        guard let result = fetchResult else { return [] }
        var refs: [ImageRef] = []
        refs.reserveCapacity(result.count)
        var cancelled = false
        result.enumerateObjects { phAsset, _, stop in
            // Cheap cancellation check — a 100k-asset enumeration is a tight
            // alloc loop, bail early if the caller's Task was cancelled.
            if Task.isCancelled {
                cancelled = true
                stop.pointee = true
                return
            }
            let id = phAsset.localIdentifier
            refs.append(ImageRef(id: id, displayName: id, url: nil))
        }
        if cancelled { throw CancellationError() }
        return refs
    }

    /// PhotoKit fast path — request a 256-px thumbnail via
    /// `PHImageManager.requestImage` and JPEG-encode at q=0.82. Without this,
    /// `ThumbnailLoader` falls through to rendering each tile from the full
    /// RAW bytes (full iCloud download + Rust develop per cell) — painful
    /// on the first browse of a new PhotoKit library. Photos' own preview
    /// store is already cached, so this is ~5–50 ms per image.
    public func thumb(for ref: ImageRef) async throws -> Data? {
        return await thumbData(for: ref.id)
    }
    public func preview(for ref: ImageRef) async throws -> Data? { nil }

    public func rawBytes(for ref: ImageRef) async throws -> Data {
        guard let data = await rawData(for: ref.id) else {
            throw ImageSourceError.notFound(ref.id)
        }
        return data
    }

    /// Photo Library sidecars aren't supported on iOS/macOS without an
    /// editable PHAssetResource — mark the source as read-only for now.
    public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        throw ImageSourceError.readOnly("PhotoKit (XMP writes require a companion sidecar store)")
    }

    public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}

// MARK: - PhotoKitError

public enum PhotoKitError: Error, LocalizedError, Sendable {
    case accessDenied(PHAuthorizationStatus)

    public var errorDescription: String? {
        switch self {
        case .accessDenied(let status):
            return "Photo Library access denied (status: \(status.rawValue)). Grant access in Settings."
        }
    }
}
