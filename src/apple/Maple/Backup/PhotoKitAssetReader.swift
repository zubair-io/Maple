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
import ImageIO
import MapleBackup
import MapleCore

actor PhotoKitAssetReader: AssetReader {

    private let deviceId: String
    private let geocode: GeocodeClient

    init(deviceId: String, geocode: GeocodeClient) {
        self.deviceId = deviceId
        self.geocode = geocode
    }

    func read(phassetLocalId: String) async throws -> AssetReadResult {
        guard let asset = PhotoKitCatalog.shared.asset(localId: phassetLocalId) else {
            throw ReaderError.assetNotFound(phassetLocalId)
        }

        let resources = PHAssetResource.assetResources(for: asset)
        guard let originalResource = resources.first(where: {
            $0.type == .photo || $0.type == .video || $0.type == .audio
        }) else {
            throw ReaderError.noOriginalResource(phassetLocalId)
        }
        let renderedResource = resources.first(where: { $0.type == .fullSizePhoto })

        // Live Photo: detect and read the paired .mov twin.
        // The paired video resource sits alongside the still as a
        // PHAssetResourceType.pairedVideo. We only read it when the asset
        // subtype flags it as a Live Photo, to avoid spurious reads.
        let isLivePhoto = asset.mediaSubtypes.contains(.photoLive)
        let liveVideoResource: PHAssetResource? = isLivePhoto
            ? resources.first(where: { $0.type == .pairedVideo })
            : nil

        let originalBytes = try await Self.readAllBytes(of: originalResource)
        let renderedBytes: Data? = if let renderedResource {
            try await Self.readAllBytes(of: renderedResource)
        } else {
            nil
        }
        let liveVideoBytes: Data? = if let liveVideoResource {
            try await Self.readAllBytes(of: liveVideoResource)
        } else {
            nil
        }

        let captureDate = asset.creationDate ?? Date()
        let lat = asset.location?.coordinate.latitude
        let lon = asset.location?.coordinate.longitude
        let filename = originalResource.originalFilename

        // Spec-form maple_id derivation. Matches the server indexer at
        // `src/api/src/workers/stages/exif.ts` so a photo that was already
        // indexed via folder scan and is now being backed up from a device
        // resolves to the *same* AssetDoc row (server's
        // `findOne({ maple_id })` short-circuits with a `$push` to
        // phasset_links rather than writing a second file).
        //
        // Primary form when EXIF DateTimeOriginal is present in the
        // original bytes; fallback (full-file BLAKE3 + filesize) otherwise.
        guard let mapleId = Self.deriveMapleId(originalBytes: originalBytes) else {
            throw ReaderError.hashFailed
        }

        // For a Live Photo, the .mov twin filename derives from the still:
        // strip the extension of the original filename and append ".mov".
        // The companion is referenced in the sidecar so the server can
        // link them. Actual twin bytes are uploaded via uploadRendered.
        // TODO: once the server rendered endpoint supports X-Maple-Suffix-Override,
        // update to write `<base>.mov` instead of `<base>.rendered.mov`.
        let liveVideoFilename: String? = liveVideoResource.map { _ in
            let base = (filename as NSString).deletingPathExtension
            return "\(base).mov"
        }
        let livePhotoCompanion: String? = liveVideoFilename

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
            livePhotoCompanion: livePhotoCompanion,
            burstStackId: asset.burstIdentifier,
            originalFilename: filename,
            mtime: asset.modificationDate?.timeIntervalSince1970
                ?? asset.creationDate?.timeIntervalSince1970
                ?? 0)

        return AssetReadResult(
            originalBytes: originalBytes,
            renderedBytes: renderedBytes,
            liveVideoBytes: liveVideoBytes,
            liveVideoFilename: liveVideoFilename,
            sidecar: sidecar,
            mapleId: mapleId)
    }

    // MARK: - Maple id derivation

    /// Compute the 32-character spec-form `maple_id` for an asset's
    /// original bytes. Reads EXIF DateTimeOriginal from the bytes (matches
    /// the indexer's `readExif` source of truth) and feeds the primary
    /// derivation when present; otherwise falls back to full-bytes hash
    /// plus filesize.
    ///
    /// Camera serial and shutter count are passed as nil/0 to match the
    /// server indexer (`src/api/src/workers/stages/exif.ts:64`), which
    /// currently doesn't surface them on `AssetExif`. When the indexer
    /// starts persisting them, this helper must update in lockstep —
    /// otherwise dedup will silently regress on cameras that report
    /// shutter counts.
    private static func deriveMapleId(originalBytes: Data) -> String? {
        if let ts = readExifDateTimeOriginalISO8601UTC(from: originalBytes) {
            // Cap the head slice at the spec's 64 KB. Hashing the whole
            // file is wasted work — `MapleId::primary` ignores everything
            // past `SHA1_HEAD_BYTES`. Use `Data(prefix:)` rather than
            // slicing so the resulting `Data` is a contiguous owned
            // buffer (the FFI binds via `withUnsafeBytes`).
            let head = originalBytes.count > 64 * 1024
                ? originalBytes.prefix(64 * 1024)
                : originalBytes
            if let id = MapleId.primary(
                headBytes: Data(head),
                capturedAtISO8601: ts
            ) {
                return id
            }
        }
        return MapleId.fallback(bytes: originalBytes)
    }

    /// Read EXIF DateTimeOriginal from the asset bytes and normalise to
    /// the ISO 8601 string the server indexer hashes
    /// (`<exifr>.DateTimeOriginal.toISOString()`).
    ///
    /// EXIF DateTimeOriginal has no timezone designator. exifr's default
    /// behaviour is to interpret it as UTC and emit a Date — we match
    /// that interpretation here so the resulting ISO 8601 string is
    /// byte-for-byte the same value the indexer feeds into BLAKE3.
    /// (If the indexer's interpretation later changes — e.g. once
    /// OffsetTimeOriginal is plumbed through — this helper has to follow.)
    ///
    /// Returns nil when DateTimeOriginal is absent or unparseable —
    /// callers fall through to fallback-form derivation.
    private static func readExifDateTimeOriginalISO8601UTC(from data: Data) -> String? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        guard let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any],
              let dateStr = exif[kCGImagePropertyExifDateTimeOriginal] as? String
        else { return nil }
        let parser = DateFormatter()
        parser.dateFormat = "yyyy:MM:dd HH:mm:ss"
        parser.timeZone = TimeZone(secondsFromGMT: 0)
        parser.locale = Locale(identifier: "en_US_POSIX")
        guard let date = parser.date(from: dateStr.trimmingCharacters(in: .whitespaces)) else {
            return nil
        }
        let out = ISO8601DateFormatter()
        out.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        out.timeZone = TimeZone(secondsFromGMT: 0)
        return out.string(from: date)
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
        case hashFailed
        var errorDescription: String? {
            switch self {
            case .assetNotFound(let id): return "PHAsset \(id) not found"
            case .noOriginalResource(let id): return "PHAsset \(id) has no original resource"
            case .hashFailed: return "BLAKE3 hash of original bytes failed (empty data)"
            }
        }
    }
}
