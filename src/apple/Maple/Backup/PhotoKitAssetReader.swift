// src/apple/Maple/Backup/PhotoKitAssetReader.swift
//
// PhotoKit-touching implementation of MapleBackup.AssetReader.
//
// Reads original (and optional Apple-rendered) bytes via PHAssetResource,
// resolves a location string via the server-side geocode_cache, and assembles
// the SidecarInput consumed by PayloadAssembler.
//
// PhotoKit isn't available in `swift test` so this file is exercised only by
// the Xcode build and the manual smoke test (Task 3.14). Keep the surface
// area minimal — push pure logic into PayloadAssembler / PathFormatter where
// it can be tested.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §8.

import Foundation
import Photos
import CryptoKit
import MapleBackup

actor PhotoKitAssetReader: AssetReader {

    private let deviceId: String
    private let geocode: GeocodeClient

    init(deviceId: String, geocode: GeocodeClient) {
        self.deviceId = deviceId
        self.geocode = geocode
    }

    func read(phassetLocalId: String) async throws -> AssetReadResult {
        guard let asset = PHAsset.fetchAssets(
            withLocalIdentifiers: [phassetLocalId], options: nil).firstObject
        else {
            throw ReaderError.assetNotFound(phassetLocalId)
        }

        let resources = PHAssetResource.assetResources(for: asset)
        guard let originalResource = resources.first(where: {
            $0.type == .photo || $0.type == .video || $0.type == .audio
        }) else {
            throw ReaderError.noOriginalResource(phassetLocalId)
        }
        let renderedResource = resources.first(where: { $0.type == .fullSizePhoto })

        let originalBytes = try await Self.readAllBytes(of: originalResource)
        let renderedBytes: Data? = try await renderedResource.map { try await Self.readAllBytes(of: $0) }

        let captureDate = asset.creationDate ?? Date()
        let lat = asset.location?.coordinate.latitude
        let lon = asset.location?.coordinate.longitude
        let filename = originalResource.originalFilename

        // BLAKE3 isn't yet exposed for Swift via raw-ffi. SHA-256 hex is a
        // stop-gap content hash — same shape (hex string), good enough for
        // dedup at the server side. Replace with BLAKE3 once the FFI lands
        // (cross-references the design doc's note on §16 maple_id parity).
        let hash = SHA256.hash(data: originalBytes)
            .map { String(format: "%02x", $0) }
            .joined()

        let sidecar = PayloadAssembler.SidecarInput(
            phassetLocalId: phassetLocalId,
            deviceId: deviceId,
            captureDate: captureDate,
            latitude: lat,
            longitude: lon,
            favorite: asset.isFavorite,
            caption: nil,
            keywords: [],
            tags: [],
            livePhotoCompanion: nil,
            burstStackId: asset.burstIdentifier,
            originalFilename: filename,
            mtime: Date().timeIntervalSince1970)

        return AssetReadResult(
            originalBytes: originalBytes,
            renderedBytes: renderedBytes,
            sidecar: sidecar,
            mapleId: hash)
    }

    // MARK: - Reading bytes

    /// Stream a PHAssetResource into a single Data buffer.
    /// Uses dataReceivedHandler so iCloud-Photos-only assets get pulled on
    /// demand (isNetworkAccessAllowed = true).
    private static func readAllBytes(of resource: PHAssetResource) async throws -> Data {
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            let lock = NSLock()
            var accumulator = Data()
            // Latch — PhotoKit fires the completion handler at most once,
            // but defensive in case future SDKs change the contract.
            var fired = false
            PHAssetResourceManager.default().requestData(
                for: resource,
                options: options,
                dataReceivedHandler: { chunk in
                    lock.lock()
                    accumulator.append(chunk)
                    lock.unlock()
                },
                completionHandler: { error in
                    lock.lock()
                    if fired { lock.unlock(); return }
                    fired = true
                    let snapshot = accumulator
                    lock.unlock()
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: snapshot)
                    }
                })
        }
    }

    enum ReaderError: Error, LocalizedError {
        case assetNotFound(String)
        case noOriginalResource(String)
        var errorDescription: String? {
            switch self {
            case .assetNotFound(let id): return "PHAsset \(id) not found"
            case .noOriginalResource(let id): return "PHAsset \(id) has no original resource"
            }
        }
    }
}
