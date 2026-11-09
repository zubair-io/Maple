// src/apple/Maple/Backup/ChangeObserverWiring+Discovery.swift
//
// Incremental and watermark-bounded PhotoKit discovery for ChangeObserverWiring.
//
// Uses a 3-tier strategy off the main actor:
//   1. PHPersistentChangeToken fast path: when an initial scan has completed
//      for the current settings fingerprint, queries PhotoKit for persistent
//      asset changes since the saved token. Returns `.noChanges` in <1ms when
//      no assets were inserted or deleted (e.g. during iCloud resource reads).
//   2. Date-watermark window scan: when resuming an interrupted initial scan or
//      when a persistent token has expired, queries only `creationDate > newest`
//      and (if initial scan is incomplete) `creationDate <= oldest OR nil`,
//      skipping the already-persisted middle range.
//   3. Full scan: enumerates all eligible assets and captures `creationDate`
//      off-main so `@MainActor` never triggers per-asset PhotoKit fetches.

import Foundation
import MapleBackup
import MapleCore
import OSLog
import Photos

private let discoveryLog = Logger(
  subsystem: "app.justmaple.aperture", category: "Backup.Discovery")

struct DiscoveredAsset: Sendable, Hashable {
  let phid: String
  let capturedAt: Date?
}

enum DiscoveryOutcome: Sendable {
  /// Persistent change token reported zero asset insertions and zero deletions.
  case noChanges(newToken: Data?)
  /// Incremental discovery via persistent change token or date-watermark bounds.
  case incremental(
    inserted: [DiscoveredAsset],
    deletedPhids: Set<String>,
    newToken: Data?,
    fingerprint: String,
    completedInitialScan: Bool
  )
  /// Full library enumeration (cold start, settings changed, or retryFailed).
  case fullScan(
    assets: [DiscoveredAsset],
    newToken: Data?,
    fingerprint: String
  )
}

extension ChangeObserverWiring {

  nonisolated static func settingsFingerprint(_ settings: BackupSettings) -> String {
    "v1:videos=\(settings.includeVideos),bursts=\(settings.includeBursts),sharedLib=\(settings.includeSharedLibrary),sharedAlbums=\(settings.includeSharedAlbums)"
  }

  nonisolated static func discoverAssets(
    cursor: BackupCursor,
    settings: BackupSettings,
    retryFailed: Bool
  ) -> DiscoveryOutcome {
    let fingerprint = settingsFingerprint(settings)
    // Snapshot the library's change token before querying so any mutation that
    // races with our fetch is observed on the next token diff.
    let newToken = currentChangeTokenData()

    let fingerprintMatches =
      cursor.settingsFingerprint == nil || cursor.settingsFingerprint == fingerprint

    // Tier 1: PHPersistentChangeToken delta when initial scan already completed.
    if !retryFailed,
      cursor.initialScanCompleted,
      cursor.settingsFingerprint == fingerprint,
      let tokenData = cursor.phChangeToken,
      let token = unarchiveChangeToken(tokenData)
    {
      do {
        let changes = try PHPhotoLibrary.shared().fetchPersistentChanges(since: token)
        var insertedIDs = Set<String>()
        var deletedIDs = Set<String>()
        for change in changes {
          let details = try change.changeDetails(for: .asset)
          insertedIDs.formUnion(details.insertedLocalIdentifiers)
          deletedIDs.formUnion(details.deletedLocalIdentifiers)
        }
        insertedIDs.subtract(deletedIDs)
        if insertedIDs.isEmpty && deletedIDs.isEmpty {
          return .noChanges(newToken: newToken)
        }
        let inserted = fetchAssetsByLocalIdentifiers(Array(insertedIDs), settings: settings)
        discoveryLog.info(
          "persistent token delta: inserted=\(inserted.count) deleted=\(deletedIDs.count)")
        return .incremental(
          inserted: inserted,
          deletedPhids: deletedIDs,
          newToken: newToken,
          fingerprint: fingerprint,
          completedInitialScan: true)
      } catch {
        discoveryLog.info(
          "persistent token unavailable (\(String(describing: error), privacy: .public)); falling back to date watermarks"
        )
      }
    }

    // Tier 2: Date-watermark window scan (expired token after completed scan,
    // or resuming an interrupted initial scan without re-checking the middle).
    let newestUpper = cursor.newestScannedAt ?? cursor.newestBackedUpAt
    let oldestLower = cursor.oldestScannedAt ?? cursor.oldestBackedUpAt
    if !retryFailed, fingerprintMatches, let newestUpper {
      if cursor.initialScanCompleted && cursor.settingsFingerprint == fingerprint {
        let newer = fetchAssetsMatching(
          predicate: NSPredicate(format: "creationDate > %@", newestUpper as NSDate),
          settings: settings)
        discoveryLog.info("watermark delta (newer-only): found=\(newer.count)")
        return .incremental(
          inserted: newer,
          deletedPhids: [],
          newToken: newToken,
          fingerprint: fingerprint,
          completedInitialScan: true)
      } else if let oldestLower {
        let newer = fetchAssetsMatching(
          predicate: NSPredicate(format: "creationDate > %@", newestUpper as NSDate),
          settings: settings)
        guard !Task.isCancelled else {
          return .incremental(
            inserted: [], deletedPhids: [], newToken: nil,
            fingerprint: fingerprint, completedInitialScan: false)
        }
        let older = fetchAssetsMatching(
          predicate: NSPredicate(
            format: "creationDate <= %@ OR creationDate == nil", oldestLower as NSDate),
          settings: settings)
        let combined = combineNewestFirst(newer, older)
        discoveryLog.info(
          "watermark resume scan: newer=\(newer.count) older=\(older.count) combined=\(combined.count)"
        )
        return .incremental(
          inserted: combined,
          deletedPhids: [],
          newToken: newToken,
          fingerprint: fingerprint,
          completedInitialScan: true)
      }
    }

    // Tier 3: Full library enumeration.
    let allAssets = walkPhotoKit(settings: settings)
    return .fullScan(assets: allAssets, newToken: newToken, fingerprint: fingerprint)
  }

  // MARK: - Persistent Change Token Helpers

  nonisolated static func currentChangeTokenData() -> Data? {
    let token = PHPhotoLibrary.shared().currentChangeToken
    return try? NSKeyedArchiver.archivedData(
      withRootObject: token, requiringSecureCoding: true)
  }

  nonisolated static func unarchiveChangeToken(_ data: Data) -> PHPersistentChangeToken? {
    try? NSKeyedUnarchiver.unarchivedObject(
      ofClass: PHPersistentChangeToken.self, from: data)
  }

  // MARK: - Off-Main PhotoKit Enumeration

  /// Full PhotoKit enumeration returning eligible assets with their capture
  /// dates sorted newest-first (`nil` dates last).
  nonisolated static func walkPhotoKit(settings: BackupSettings) -> [DiscoveredAsset] {
    let sharedAlbumIDs: Set<String> =
      settings.includeSharedAlbums
      ? []
      : PhotoKitCatalog.shared.sharedAlbumIdentifiers()

    var assets: [DiscoveredAsset] = []
    let imageIDs = PhotoKitCatalog.shared.imageIdentifiers()
    assets.reserveCapacity(imageIDs.count)
    for phid in imageIDs {
      guard !Task.isCancelled else { return [] }
      guard let asset = PhotoKitCatalog.shared.asset(localId: phid),
        shouldInclude(asset, settings: settings, sharedAlbumIDs: sharedAlbumIDs)
      else { continue }
      assets.append(DiscoveredAsset(phid: phid, capturedAt: asset.creationDate))
    }

    if settings.includeVideos {
      let videoIDs = PhotoKitCatalog.shared.videoIdentifiers()
      var videos: [DiscoveredAsset] = []
      videos.reserveCapacity(videoIDs.count)
      for phid in videoIDs {
        guard !Task.isCancelled else { return [] }
        guard let asset = PhotoKitCatalog.shared.asset(localId: phid),
          shouldInclude(asset, settings: settings, sharedAlbumIDs: sharedAlbumIDs)
        else { continue }
        videos.append(DiscoveredAsset(phid: phid, capturedAt: asset.creationDate))
      }
      if !videos.isEmpty {
        assets = combineNewestFirst(assets, videos)
      }
    }
    return assets
  }

  nonisolated private static func fetchAssetsByLocalIdentifiers(
    _ ids: [String], settings: BackupSettings
  ) -> [DiscoveredAsset] {
    guard !ids.isEmpty else { return [] }
    let sharedAlbumIDs: Set<String> =
      settings.includeSharedAlbums
      ? []
      : PhotoKitCatalog.shared.sharedAlbumIdentifiers()

    let opts = PHFetchOptions()
    opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    if settings.includeVideos {
      opts.predicate = NSPredicate(
        format: "mediaType == %d OR mediaType == %d",
        PHAssetMediaType.image.rawValue,
        PHAssetMediaType.video.rawValue)
    } else {
      opts.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    }
    let result = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: opts)
    var out: [DiscoveredAsset] = []
    out.reserveCapacity(result.count)
    var cacheUpdate: [String: PHAsset] = [:]
    result.enumerateObjects { asset, _, stop in
      if Task.isCancelled {
        stop.pointee = true
        return
      }
      guard shouldInclude(asset, settings: settings, sharedAlbumIDs: sharedAlbumIDs) else {
        return
      }
      let phid = asset.localIdentifier
      cacheUpdate[phid] = asset
      out.append(DiscoveredAsset(phid: phid, capturedAt: asset.creationDate))
    }
    if !cacheUpdate.isEmpty {
      PhotoKitCatalog.shared.mergeAssetCache(cacheUpdate)
    }
    return sortNewestFirst(out)
  }

  nonisolated private static func fetchAssetsMatching(
    predicate: NSPredicate, settings: BackupSettings
  ) -> [DiscoveredAsset] {
    let sharedAlbumIDs: Set<String> =
      settings.includeSharedAlbums
      ? []
      : PhotoKitCatalog.shared.sharedAlbumIdentifiers()

    let images = fetchMediaType(
      .image, predicate: predicate, settings: settings, sharedAlbumIDs: sharedAlbumIDs)
    guard !Task.isCancelled else { return [] }
    guard settings.includeVideos else { return images }
    let videos = fetchMediaType(
      .video, predicate: predicate, settings: settings, sharedAlbumIDs: sharedAlbumIDs)
    guard !Task.isCancelled else { return [] }
    return videos.isEmpty ? images : combineNewestFirst(images, videos)
  }

  nonisolated private static func fetchMediaType(
    _ mediaType: PHAssetMediaType,
    predicate: NSPredicate,
    settings: BackupSettings,
    sharedAlbumIDs: Set<String>
  ) -> [DiscoveredAsset] {
    let opts = PHFetchOptions()
    opts.predicate = predicate
    opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    let result = PHAsset.fetchAssets(with: mediaType, options: opts)
    var out: [DiscoveredAsset] = []
    out.reserveCapacity(result.count)
    var cacheUpdate: [String: PHAsset] = [:]
    result.enumerateObjects { asset, _, stop in
      if Task.isCancelled {
        stop.pointee = true
        return
      }
      guard shouldInclude(asset, settings: settings, sharedAlbumIDs: sharedAlbumIDs) else {
        return
      }
      let phid = asset.localIdentifier
      cacheUpdate[phid] = asset
      out.append(DiscoveredAsset(phid: phid, capturedAt: asset.creationDate))
    }
    if !cacheUpdate.isEmpty {
      PhotoKitCatalog.shared.mergeAssetCache(cacheUpdate)
    }
    return out
  }

  nonisolated static func shouldInclude(
    _ asset: PHAsset, settings: BackupSettings,
    sharedAlbumIDs: Set<String> = []
  ) -> Bool {
    if !settings.includeBursts,
      asset.burstIdentifier != nil,
      !asset.representsBurst
    {
      return false
    }
    if !settings.includeSharedLibrary,
      asset.sourceType == .typeCloudShared
    {
      return false
    }
    if !settings.includeSharedAlbums,
      sharedAlbumIDs.contains(asset.localIdentifier)
    {
      return false
    }
    return true
  }

  nonisolated private static func combineNewestFirst(
    _ first: [DiscoveredAsset], _ second: [DiscoveredAsset]
  ) -> [DiscoveredAsset] {
    var seen = Set<String>()
    seen.reserveCapacity(first.count + second.count)
    var combined: [DiscoveredAsset] = []
    combined.reserveCapacity(first.count + second.count)
    for item in first where seen.insert(item.phid).inserted {
      combined.append(item)
    }
    for item in second where seen.insert(item.phid).inserted {
      combined.append(item)
    }
    return sortNewestFirst(combined)
  }

  nonisolated private static func sortNewestFirst(
    _ assets: [DiscoveredAsset]
  ) -> [DiscoveredAsset] {
    assets.sorted { a, b in
      switch (a.capturedAt, b.capturedAt) {
      case (let x?, let y?) where x != y: return x > y
      case (.some, .none): return true
      case (.none, .some): return false
      default: return a.phid < b.phid
      }
    }
  }

  /// Notify the server that the given phasset localIdentifiers were deleted
  /// from Apple Photos. The server sets `deleted_from_photos: true` on the
  /// matching AssetDoc entries. Best-effort: network failures are silently
  /// swallowed — the next walk will retry the diff.
  static func notifyDeleted(
    deviceId: String, libraryId: String,
    serverBaseURL: URL, phids: [String]
  ) async {
    let url = LocalNetworkResolver.shared.effectiveURL(for: serverBaseURL)
      .appendingPathComponent("api")
      .appendingPathComponent("libraries")
      .appendingPathComponent(libraryId)
      .appendingPathComponent("backup")
      .appendingPathComponent("notify-deleted")
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")
    req.httpBody = try? JSONEncoder().encode(["phasset_local_ids": phids])
    let transport = makeBackupTransport(server: serverBaseURL)
    _ = try? await transport(req)
  }
}
