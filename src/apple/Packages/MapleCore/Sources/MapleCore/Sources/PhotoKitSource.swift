// PhotoKitSource.swift — PHFetchResult-based source adapter.
//
// Requests Photo Library access, fetches all RAW assets via PHImageManager,
// and exposes them as `PhotoKitAsset` items compatible with EditSession.
//
// RAW bytes: PHImageRequestOptions with PHImageRequestOptionsVersion.unadjusted
// and allowNetworkAccess=false to get the full RAW buffer for Rust pipeline.

import Foundation
import Photos

// MARK: - PhotoKitSource

/// Fetches RAW/DNG assets from the user's Photo Library.
public actor PhotoKitSource {

    // MARK: Types

    public struct PhotoKitAsset: Sendable, Identifiable, Hashable {
        public let id: String        // PHAsset.localIdentifier
        public let asset: PHAsset

        public var name: String { asset.localIdentifier }
        public static func == (lhs: PhotoKitAsset, rhs: PhotoKitAsset) -> Bool { lhs.id == rhs.id }
        public func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }

    // MARK: State

    private var _assets: [PhotoKitAsset] = []
    private var authStatus: PHAuthorizationStatus = .notDetermined

    public var assets: [PhotoKitAsset] { _assets }

    public init() {}

    // MARK: Public API

    /// Request Photo Library authorization and fetch RAW assets.
    /// Throws `PhotoKitError.accessDenied` if permission is not granted.
    public func requestAccessAndFetch() async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        authStatus = status
        guard status == .authorized || status == .limited else {
            throw PhotoKitError.accessDenied(status)
        }
        _assets = fetchRAWAssets()
    }

    /// Fetch the raw image bytes for an asset (for the Rust pipeline).
    /// Returns nil if the asset is not available locally.
    public func rawData(for asset: PhotoKitAsset) async -> Data? {
        return await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.version = .unadjusted
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = false
            options.isSynchronous = false

            PHImageManager.default().requestImageDataAndOrientation(
                for: asset.asset,
                options: options
            ) { data, _, _, _ in
                continuation.resume(returning: data)
            }
        }
    }

    // MARK: Private

    private func fetchRAWAssets() -> [PhotoKitAsset] {
        let fetchOptions = PHFetchOptions()
        fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        // Fetch image assets that may include RAW originals
        let result = PHAsset.fetchAssets(with: .image, options: fetchOptions)
        var assets: [PhotoKitAsset] = []
        result.enumerateObjects { phAsset, _, _ in
            // Check if the asset has a RAW original
            let resources = PHAssetResource.assetResources(for: phAsset)
            let hasRAW = resources.contains { r in
                let ext = (r.originalFilename as NSString).pathExtension.lowercased()
                return RAWExtensions.all.contains(ext)
            }
            if hasRAW {
                assets.append(PhotoKitAsset(id: phAsset.localIdentifier, asset: phAsset))
            }
        }
        return assets
    }
}

// MARK: - ImageSource conformance

extension PhotoKitSource: ImageSource {
    /// `ImageRef.id` is the `PHAsset.localIdentifier`. `url` is `nil` because
    /// the Photos library uses opaque identifiers, not filesystem URLs.
    public func images() async throws -> [ImageRef] {
        _assets.map { pa in
            // Prefer the original filename as display name when resources
            // are available; fall back to the PHAsset local identifier.
            let resources = PHAssetResource.assetResources(for: pa.asset)
            let fileName = resources.first?.originalFilename ?? pa.asset.localIdentifier
            return ImageRef(id: pa.id, displayName: fileName, url: nil)
        }
    }

    public func thumb(for ref: ImageRef) async throws -> Data? { nil }
    public func preview(for ref: ImageRef) async throws -> Data? { nil }

    public func rawBytes(for ref: ImageRef) async throws -> Data {
        guard let pa = _assets.first(where: { $0.id == ref.id }) else {
            throw ImageSourceError.notFound(ref.id)
        }
        guard let data = await rawData(for: pa) else {
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

public enum PhotoKitError: Error, LocalizedError {
    case accessDenied(PHAuthorizationStatus)

    public var errorDescription: String? {
        switch self {
        case .accessDenied(let status):
            return "Photo Library access denied (status: \(status.rawValue)). Grant access in Settings."
        }
    }
}
