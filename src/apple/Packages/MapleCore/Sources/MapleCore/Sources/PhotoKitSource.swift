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
//
// Library-change observation: the source registers with the process-wide
// `PhotoKitChangeObserver` singleton at init and clears its cached fetch
// result on any library change. PhotoKit's `PHFetchResult` is a snapshot —
// after a change in another app, calling `enumerateObjects` on a stale result
// throws an obscure error rather than reporting the new contents. Mirroring
// the working `../Maple/.../PhotoKit/PhotoKitBridge.swift` pattern: drop the
// snapshot on change so the next `fetchAssets(for:)` re-queries.

import Foundation
import CoreGraphics
import ImageIO
import Photos
import MapleBackup

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - PhotoKitSourceError

/// Errors thrown during `PhotoKitSource` initialisation.
public enum PhotoKitSourceError: Error, LocalizedError, Sendable {
    case sidecarRootUnavailable(Error)

    public var errorDescription: String? {
        switch self {
        case .sidecarRootUnavailable(let underlying):
            return "PhotoKit sidecar root unavailable: \(underlying.localizedDescription)"
        }
    }
}

// MARK: - PhotoKitSource

/// Browses a filtered view of the user's Photo Library.
public actor PhotoKitSource {

    // MARK: State

    private var fetchResult: PHFetchResult<PHAsset>?
    private var lastFilter: PhotoKitFilter?
    private var authStatus: PHAuthorizationStatus = .notDetermined
    private var changeObserverToken: UUID?

    /// Sidecar store for PhotoKit assets. Sidecars are written here because
    /// PhotoKit assets have no stable on-disk URL to place a `.xmp` beside.
    private let sidecarStore: AppSupportSidecarStore

    /// O(1). Backed by the PHFetchResult count (SQLite `COUNT(*)` on the
    /// predicate, not an array length).
    public var count: Int { fetchResult?.count ?? 0 }

    /// Designated init. Throws `PhotoKitSourceError.sidecarRootUnavailable`
    /// if the App Support directory cannot be created (e.g. filesystem
    /// permission issue) — callers should handle the error gracefully rather
    /// than letting a `fatalError` crash the app.
    public init() throws {
        do {
            self.sidecarStore = AppSupportSidecarStore(
                root: try AppSupportSidecarStore.defaultRoot())
        } catch {
            throw PhotoKitSourceError.sidecarRootUnavailable(error)
        }
        // Subscribe to library-change notifications so a photo added in
        // another app invalidates our cached snapshot. The handler runs on
        // a PhotoKit-private thread; we hop to the actor with `Task`.
        let token = PhotoKitChangeObserver.shared.subscribe { [weak self] in
            guard let self else { return }
            Task { await self.invalidateSnapshot() }
        }
        // `actor` init can write to `self` directly without an async hop.
        self.changeObserverToken = token
    }

    /// Test-only initialiser that injects an explicit sidecar store so a unit
    /// test can isolate the on-disk side-effect to a tmp directory rather than
    /// touching the user's real Application Support folder.
    internal init(sidecarOverride: AppSupportSidecarStore) {
        self.sidecarStore = sidecarOverride
        let token = PhotoKitChangeObserver.shared.subscribe { [weak self] in
            guard let self else { return }
            Task { await self.invalidateSnapshot() }
        }
        self.changeObserverToken = token
    }

    deinit {
        if let token = changeObserverToken {
            PhotoKitChangeObserver.shared.unsubscribe(token)
        }
    }

    /// Drop the cached fetch result so the next `images()` call re-queries.
    /// Called from the change-observer fan-out.
    private func invalidateSnapshot() {
        fetchResult = nil
    }

    // MARK: Public API

    /// Request Photo Library authorization and fetch the "all images" view.
    /// Throws `PhotoKitError.accessDenied` if permission is not granted.
    public func requestAccessAndFetch() async throws {
        try await fetchAssets(for: .all)
    }

    /// Configure the source to apply `filter`. Authorization is checked
    /// (synchronously, via `PHPhotoLibrary.authorizationStatus(for:)`) but
    /// NOT requested here — the AppShell-level callers either prompt the
    /// user from the grid's "Grant Access" button or via the dedicated
    /// `PhotoKitLibrary.requestAuthorization()` call before reaching here.
    /// Throwing on a not-yet-granted status would suppress the lazy fetch
    /// the AppShell wires up between auth grant and source build.
    /// Returns as soon as PhotoKit has run the predicate — no iteration
    /// of the result.
    public func fetchAssets(for filter: PhotoKitFilter) async throws {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        authStatus = status
        guard status == .authorized || status == .limited else {
            throw PhotoKitError.accessDenied(status)
        }
        lastFilter = filter
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

    /// Look up a PHAsset by its `localIdentifier` via the process-wide
    /// `PhotoKitCatalog`. The catalog memoises results so repeated calls
    /// for the same id are O(1) after the first hit.
    private func phAsset(for localID: String) -> PHAsset? {
        PhotoKitCatalog.shared.asset(localId: localID)
    }

    /// Fetch the raw image bytes for an asset by localIdentifier (for the
    /// Rust pipeline). Returns nil if the asset is not available locally.
    /// Network access is enabled so iCloud-Photos-only assets can be
    /// downloaded on demand — without it `requestImageDataAndOrientation`
    /// returns nil bytes for any asset whose original lives in iCloud and
    /// hasn't been pulled to this device, which is the default state for a
    /// huge fraction of large libraries on Apple-silicon Macs / iPads.
    /// The reference repo's `requestCGImage` helper enables network access
    /// for the same reason.
    public func rawData(for localID: String) async -> Data? {
        await rawDataWithMetadata(for: localID)?.data
    }

    /// Variant of `rawData(for:)` that also returns the data UTI so the
    /// caller can drive the non-RAW vs RAW dispatch in EditSession (HEIF
    /// photos shipped from an iPhone don't have a stable extension; the
    /// UTI is what tells us whether we're looking at `public.heic` /
    /// `public.jpeg` / `public.png` vs `com.adobe.raw-image`).
    public func rawDataWithMetadata(for localID: String) async -> (data: Data, dataUTI: String?)? {
        guard let phAsset = phAsset(for: localID) else { return nil }
        return await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.version = .unadjusted
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = true
            options.isSynchronous = false

            // `requestImageDataAndOrientation` with `.highQualityFormat`
            // should fire the callback exactly once, but PhotoKit's docs
            // explicitly warn callers to handle multiple invocations on
            // some delivery modes. Guard the continuation with a one-shot
            // latch — resuming it twice fatally crashes the process under
            // `withCheckedContinuation`, and a defensive guard costs us
            // nothing.
            final class ResumeLatch: @unchecked Sendable {
                private let lock = NSLock()
                private var fired = false
                func tryFire() -> Bool {
                    lock.lock(); defer { lock.unlock() }
                    if fired { return false }
                    fired = true
                    return true
                }
            }
            let latch = ResumeLatch()

            PHImageManager.default().requestImageDataAndOrientation(
                for: phAsset,
                options: options
            ) { data, dataUTI, _, _ in
                if latch.tryFire() {
                    if let data {
                        continuation.resume(returning: (data, dataUTI))
                    } else {
                        continuation.resume(returning: nil)
                    }
                }
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
        return Self.avifBytes(from: image)
    }

    // MARK: - AVIF encoding

    /// Encode a platform image (NSImage on macOS, UIImage on iOS/iPadOS) to
    /// AVIF bytes via the shared `ThumbnailEncoder`. The CGImage extraction
    /// stays platform-specific (`cgImage(from:)` below); the encode itself
    /// is shared with the URL-backed thumbnail path in
    /// `ThumbnailDiskCache`/`ThumbnailLoader` — two real callers wanting the
    /// same AVIF-encode behavior is exactly the trigger for pulling this out
    /// of a per-source duplicate.
    private static func avifBytes(from image: PlatformImage) -> Data? {
        guard let cg = cgImage(from: image) else { return nil }
        return ThumbnailEncoder.encode(cg)
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
    ///
    /// If the cached snapshot was invalidated by the library-change observer
    /// between `fetchAssets(for:)` and this call, transparently re-fetch
    /// using the last filter so the caller doesn't see a spurious empty
    /// list. Throwing `notAuthorized` here (rather than returning empty)
    /// surfaces the wider problem — the AppShell's auth check rejected the
    /// load before reaching this point — so an unexpected nil snapshot is a
    /// programming error worth logging, not a silent zero.
    public func images() async throws -> [ImageRef] {
        if fetchResult == nil, let filter = lastFilter {
            try await fetchAssets(for: filter)
        }
        guard let result = fetchResult else {
            throw PhotoKitError.notFetched
        }
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
            refs.append(ImageRef(id: id, displayName: id, url: nil,
                                 captureDate: phAsset.creationDate))
        }
        if cancelled { throw CancellationError() }
        return refs
    }

    /// Return a bounded window without materializing the complete Photos
    /// library. `PHFetchResult` remains the lazy backing store.
    public func images(offset: Int, limit: Int) async throws -> [ImageRef] {
        if fetchResult == nil, let filter = lastFilter {
            try await fetchAssets(for: filter)
        }
        guard let result = fetchResult else { throw PhotoKitError.notFetched }
        let lower = max(0, offset)
        let upper = min(result.count, lower + max(0, limit))
        guard lower < upper else { return [] }
        return (lower..<upper).map { index in
            let asset = result.object(at: index)
            return ImageRef(
                id: asset.localIdentifier,
                displayName: asset.localIdentifier,
                url: nil,
                captureDate: asset.creationDate
            )
        }
    }

    public func imageCount() async throws -> Int {
        if fetchResult == nil, let filter = lastFilter {
            try await fetchAssets(for: filter)
        }
        guard let result = fetchResult else { throw PhotoKitError.notFetched }
        return result.count
    }

    /// PhotoKit fast path — request a 256-px thumbnail via
    /// `PHImageManager.requestImage` and AVIF-encode at `ThumbnailEncoder.quality`. Without this,
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

    public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        let xml = XMPSerializer.serialize(model: sidecar.model, culling: sidecar.culling)
        try sidecarStore.write(phassetLocalId: ref.id, xmp: xml)
    }

    /// Read the App-Support sidecar for a PhotoKit asset, or return defaults
    /// when none exists yet. Mirrors XMPSidecarStore.loadIfPresent semantics
    /// for the PhotoKit-source case where the asset has no on-disk RAW URL.
    ///
    /// A UTF-8 decode failure (corrupt sidecar) falls through to defaults
    /// rather than crashing the edit flow. The error is not swallowed
    /// silently — a follow-up should plumb it to a UI-level warning so the
    /// user knows their edits may need re-applying.
    public func readXMP(for ref: ImageRef) async throws -> (AdjustmentModel, CullingState) {
        let xml: String?
        do {
            xml = try sidecarStore.read(phassetLocalId: ref.id)
        } catch {
            // Treat decode failure as "no sidecar" rather than propagating an
            // error that would block opening the image. TODO: surface a UI
            // warning once the warning-banner infrastructure is in place.
            return (.default, CullingState())
        }
        guard let xml, let data = xml.data(using: .utf8) else {
            return (.default, CullingState())
        }
        return try XMPParser.parse(data: data)
    }

    public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}

// MARK: - PhotoKitError

public enum PhotoKitError: Error, LocalizedError, Sendable {
    case accessDenied(PHAuthorizationStatus)
    /// `images()` was called before `fetchAssets(for:)` set up a snapshot —
    /// AppShell should drive the source with `try await source.fetchAssets`
    /// first.
    case notFetched

    public var errorDescription: String? {
        switch self {
        case .accessDenied(let status):
            return "Photo Library access denied (status: \(status.rawValue)). Grant access in Settings."
        case .notFetched:
            return "Photo Library asset list requested before the predicate was applied — call fetchAssets(for:) first."
        }
    }
}
