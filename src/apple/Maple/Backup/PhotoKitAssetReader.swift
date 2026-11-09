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
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §8.

import Foundation
import ImageIO
import MapleBackup
import MapleCore
import Photos
import UniformTypeIdentifiers

actor PhotoKitAssetReader: AssetReader {

  private let deviceId: String
  private let geocode: GeocodeClient
  private let includeLivePhotos: Bool

  init(deviceId: String, geocode: GeocodeClient, includeLivePhotos: Bool = true) {
    self.deviceId = deviceId
    self.geocode = geocode
    self.includeLivePhotos = includeLivePhotos
  }

  func read(phassetLocalId: String) async throws -> AssetReadResult {
    try await Self.performRead(
      phassetLocalId: phassetLocalId,
      deviceId: deviceId,
      includeLivePhotos: includeLivePhotos,
      onStatus: { _ in })
  }

  func read(
    phassetLocalId: String,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult {
    try await Self.performRead(
      phassetLocalId: phassetLocalId,
      deviceId: deviceId,
      includeLivePhotos: includeLivePhotos,
      onStatus: onStatus)
  }

  func readCompanion(_ kind: CompanionKind, phassetLocalId: String) async throws -> Data? {
    try await Self.performReadCompanion(
      kind, phassetLocalId: phassetLocalId, includeLivePhotos: includeLivePhotos)
  }

  /// Nonisolated primary read so concurrent `BackupEngine` workers do not
  /// serialize PhotoKit resource queries or BLAKE3 hashing on the actor.
  /// Companion resources (`fullSizePhoto` and `pairedVideo`) are deferred to
  /// `readCompanion` after the primary bytes upload completes.
  nonisolated private static func performRead(
    phassetLocalId: String,
    deviceId: String,
    includeLivePhotos: Bool,
    onStatus: @escaping @Sendable (String) async -> Void
  ) async throws -> AssetReadResult {
    guard let asset = PhotoKitCatalog.shared.asset(localId: phassetLocalId) else {
      throw ReaderError.assetNotFound(phassetLocalId)
    }

    let resources = PHAssetResource.assetResources(for: asset)
    guard
      let originalResource = resources.first(where: {
        $0.type == .photo || $0.type == .video || $0.type == .audio
      })
    else {
      throw ReaderError.noOriginalResource(phassetLocalId)
    }
    let (renderedResource, liveVideoResource) = Self.companionResources(
      for: asset, resources: resources, includeLivePhotos: includeLivePhotos)

    let originalBytes = try await Self.readAllBytes(of: originalResource, onStatus: onStatus)

    let captureDate = asset.creationDate ?? Date()
    let lat = asset.location?.coordinate.latitude
    let lon = asset.location?.coordinate.longitude
    let filename = originalResource.originalFilename

    let phassetCloudId = Self.resolveCloudIdentifier(for: phassetLocalId)

    guard let mapleId = await Self.deriveMapleId(originalBytes: originalBytes, filename: filename)
    else {
      throw ReaderError.hashFailed
    }

    let liveVideoFilename: String? = liveVideoResource.map { _ in
      let base = (filename as NSString).deletingPathExtension
      return "\(base).mov"
    }

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
      livePhotoCompanion: liveVideoFilename,
      burstStackId: asset.burstIdentifier,
      originalFilename: filename,
      mtime: asset.modificationDate?.timeIntervalSince1970
        ?? asset.creationDate?.timeIntervalSince1970
        ?? 0,
      phassetCloudId: phassetCloudId)

    return AssetReadResult(
      originalBytes: originalBytes,
      renderedBytes: nil,
      renderedFilenameExtension: renderedResource.flatMap(Self.filenameExtension(of:)),
      liveVideoBytes: nil,
      liveVideoFilename: liveVideoFilename,
      sidecar: sidecar,
      mapleId: mapleId,
      deferredCompanions: Set(
        [
          renderedResource.map { _ in CompanionKind.rendered },
          liveVideoResource.map { _ in CompanionKind.liveVideo },
        ].compactMap { $0 }))
  }

  nonisolated private static func performReadCompanion(
    _ kind: CompanionKind, phassetLocalId: String, includeLivePhotos: Bool
  ) async throws -> Data? {
    guard let asset = PhotoKitCatalog.shared.asset(localId: phassetLocalId) else { return nil }
    let companions = Self.companionResources(
      for: asset, resources: PHAssetResource.assetResources(for: asset),
      includeLivePhotos: includeLivePhotos)
    let resource =
      switch kind {
      case .rendered: companions.rendered
      case .liveVideo: companions.liveVideo
      }
    guard let resource else { return nil }
    return try await Self.readAllBytes(of: resource)
  }

  nonisolated private static func companionResources(
    for asset: PHAsset, resources: [PHAssetResource], includeLivePhotos: Bool
  ) -> (rendered: PHAssetResource?, liveVideo: PHAssetResource?) {
    let rendered = resources.first(where: { $0.type == .fullSizePhoto })
    let liveVideo =
      (includeLivePhotos && asset.mediaSubtypes.contains(.photoLive))
      ? resources.first(where: { $0.type == .pairedVideo })
      : nil
    return (rendered, liveVideo)
  }

  nonisolated private static func filenameExtension(of resource: PHAssetResource) -> String? {
    let declared = UTType(resource.uniformTypeIdentifier)?.preferredFilenameExtension
    let named = (resource.originalFilename as NSString).pathExtension
    return declared ?? (named.isEmpty ? nil : named)
  }

  // MARK: - Cloud identifier resolution

  /// Resolve `PHCloudIdentifier.stringValue` for the local id, or nil
  /// when the asset has no cloud counterpart (iCloud Photos off, asset
  /// pending sync, deleted, etc.). Local Photos-DB lookup — no network.
  nonisolated private static func resolveCloudIdentifier(for localId: String) -> String? {
    let mappings = PHPhotoLibrary.shared().cloudIdentifierMappings(
      forLocalIdentifiers: [localId])
    guard let entry = mappings[localId] else { return nil }
    switch entry {
    case .success(let cloudId): return cloudId.stringValue
    case .failure: return nil
    }
  }

  // MARK: - Maple id derivation

  /// Compute the 32-character spec-form `maple_id` for an asset's
  /// original bytes. Reads the capture date the way the indexer's
  /// `readExif` does (`MapleIdDerivation.capturedAt`: the raw EXIF tags for
  /// stills, the QuickTime `moov` date for videos) and feeds the primary derivation
  /// when present; otherwise falls back to full-bytes hash plus filesize.
  ///
  /// Camera serial and shutter count are passed as nil/0 to match the
  /// server indexer (`src/api/src/workers/stages/exif.ts:64`), which
  /// currently doesn't surface them on `AssetExif`. When the indexer
  /// starts persisting them, this helper must update in lockstep —
  /// otherwise dedup will silently regress on cameras that report
  /// shutter counts.
  nonisolated private static func deriveMapleId(originalBytes: Data, filename: String) async
    -> String?
  {
    let capturedAt = try? await MapleIdDerivation.capturedAt(
      fileExtension: (filename as NSString).pathExtension, reader: .data(originalBytes))
    if let ts = capturedAt {
      // Cap the head slice at the spec's 64 KB. Hashing the whole
      // file is wasted work — `MapleId::primary` ignores everything
      // past `SHA1_HEAD_BYTES`. Use `Data(prefix:)` rather than
      // slicing so the resulting `Data` is a contiguous owned
      // buffer (the FFI binds via `withUnsafeBytes`).
      let head =
        originalBytes.count > 64 * 1024
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

  // MARK: - Reading bytes

  /// Stream a PHAssetResource into a single Data buffer.
  /// Uses dataReceivedHandler so iCloud-Photos-only assets get pulled on
  /// demand (isNetworkAccessAllowed = true).
  nonisolated private static func readAllBytes(
    of resource: PHAssetResource,
    onStatus: @escaping @Sendable (String) async -> Void = { _ in }
  ) async throws -> Data {
    await onStatus("Reading Photos…")
    let request = try PhotoResourceRead()
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        request.begin(resource: resource, continuation: continuation, onStatus: onStatus)
      }
    } onCancel: {
      request.finish(error: CancellationError())
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

/// Owns the PhotoKit callback lifetime. Cancellation resumes immediately even
/// if PhotoKit never sends completion; a silent resource request times out.
private final class PhotoResourceRead: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Data, Error>?
  private var requestID: PHAssetResourceDataRequestID?
  private let buffer: BackupResourceBuffer
  private var finished = false
  private var terminalError: Error?
  private var lastActivity = Date()
  private var cloudProgress = -1.0
  private var timer: DispatchSourceTimer?

  init() throws { buffer = try BackupResourceBuffer() }

  func begin(
    resource: PHAssetResource, continuation: CheckedContinuation<Data, Error>,
    onStatus: @escaping @Sendable (String) async -> Void
  ) {
    lock.lock()
    if finished {
      let error = terminalError ?? CancellationError()
      lock.unlock()
      continuation.resume(throwing: error)
      return
    }
    self.continuation = continuation
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    self.timer = timer
    timer.schedule(deadline: .now() + 10, repeating: 10)
    timer.setEventHandler { [weak self] in self?.checkTimeout() }
    timer.resume()
    lock.unlock()
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    options.progressHandler = { [weak self] progress in
      guard self?.advanced(progress) == true else { return }
      Task { await onStatus("Downloading from iCloud · \(Int(progress * 100))%") }
    }
    let id = PHAssetResourceManager.default().requestData(
      for: resource, options: options,
      dataReceivedHandler: { [weak self] in self?.received($0) },
      completionHandler: { [weak self] in self?.finish(error: $0) })
    lock.lock()
    requestID = id
    let cancel = finished
    lock.unlock()
    if cancel { PHAssetResourceManager.default().cancelDataRequest(id) }
  }

  private func advanced(_ progress: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !finished, progress > cloudProgress else { return false }
    cloudProgress = progress
    lastActivity = Date()
    return true
  }

  private func received(_ chunk: Data) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    do {
      try buffer.append(chunk)
      lastActivity = Date()
      lock.unlock()
    } catch {
      lock.unlock()
      finish(error: error)
    }
  }

  private func checkTimeout() {
    lock.lock()
    let timedOut = !finished && Date().timeIntervalSince(lastActivity) >= 60
    lock.unlock()
    if timedOut {
      finish(
        error: NSError(
          domain: "MapleBackup.Photos", code: 1,
          userInfo: [
            NSLocalizedDescriptionKey:
              "Photos/iCloud has not delivered data for 60 seconds. Retrying this photo."
          ]))
    }
  }

  func finish(error: Error?) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    terminalError = error
    let continuation = self.continuation
    self.continuation = nil
    let result: Result<Data, Error>
    if let error {
      buffer.cancel()
      result = .failure(error)
    } else {
      result = Result { try buffer.finish() }
    }
    let id = requestID
    timer?.cancel()
    timer = nil
    lock.unlock()
    if let error {
      if let id { PHAssetResourceManager.default().cancelDataRequest(id) }
    }
    continuation?.resume(with: result)
  }
}
