// src/apple/Maple/Backup/ChangeObserverWiring+Discovery.swift
//
// Off-main PhotoKit discovery for ChangeObserverWiring. A walk either replays
// PhotoKit's persistent changes since the token saved by the last walk, or
// lists every eligible asset; `BackupCursor.discovery` picks which. Both
// capture `creationDate` here so the main actor never fetches assets one by
// one. A token PhotoKit can no longer replay falls back to the full listing.

import Foundation
import MapleBackup
import MapleCore
import OSLog
import Photos

private let discoveryLog = Logger(
  subsystem: "app.justmaple.aperture", category: "Backup.Discovery")

extension ChangeObserverWiring {

  /// What a full scan's listing depends on: the inclusion settings, and
  /// whether Photos access covers the whole library or only selected photos.
  nonisolated static func settingsFingerprint(
    _ settings: BackupSettings, fullLibraryAccess: Bool
  ) -> String {
    "v1:videos=\(settings.includeVideos),bursts=\(settings.includeBursts),sharedLib=\(settings.includeSharedLibrary),sharedAlbums=\(settings.includeSharedAlbums),fullAccess=\(fullLibraryAccess)"
  }

  /// The token is taken before PhotoKit is queried, so a change racing the
  /// query is replayed by the next walk rather than lost.
  nonisolated static func discoverAssets(
    _ discovery: BackupDiscovery, settings: BackupSettings
  ) -> DiscoveryOutcome {
    let newToken = currentChangeTokenData()
    if case .changesSince(let token) = discovery,
      let changes = persistentChanges(since: token, settings: settings)
    {
      return DiscoveryOutcome(
        assets: changes.inserted, deletedPhids: changes.deleted, newToken: newToken,
        isFullScan: false)
    }
    return DiscoveryOutcome(
      assets: walkPhotoKit(settings: settings), deletedPhids: [], newToken: newToken,
      isFullScan: true)
  }

  nonisolated private static func persistentChanges(
    since tokenData: Data, settings: BackupSettings
  ) -> (inserted: [DiscoveredAsset], deleted: Set<String>)? {
    guard
      let token = try? NSKeyedUnarchiver.unarchivedObject(
        ofClass: PHPersistentChangeToken.self, from: tokenData)
    else { return nil }
    do {
      let details = try PHPhotoLibrary.shared().fetchPersistentChanges(since: token)
        .map { try $0.changeDetails(for: .asset) }
      // Changes arrive unordered, so a photo deleted and then restored from
      // Recently Deleted is reported deleted; only ones still missing count.
      let reportedDeleted = Set(details.flatMap(\.deletedLocalIdentifiers))
      let deleted = reportedDeleted.subtracting(existingIdentifiers(Array(reportedDeleted)))
      let inserted = Set(details.flatMap(\.insertedLocalIdentifiers)).subtracting(deleted)
      let assets = fetchAssets(localIdentifiers: Array(inserted), settings: settings)
      discoveryLog.info(
        "persistent changes: inserted=\(assets.count) deleted=\(deleted.count)")
      return (assets, deleted)
    } catch {
      discoveryLog.info(
        "persistent changes unavailable (\(String(describing: error), privacy: .public)); listing the full library"
      )
      return nil
    }
  }

  /// The members of `ids` PhotoKit still has an asset for, whatever the
  /// inclusion settings: a photo a setting excludes, a hidden one and a
  /// non-representative burst frame all still exist.
  static func identifiersStillInPhotoKit(among ids: Set<String>) async -> Set<String> {
    guard !ids.isEmpty else { return [] }
    let lookup = Task.detached(priority: .utility) { existingIdentifiers(Array(ids)) }
    return await withTaskCancellationHandler {
      await lookup.value
    } onCancel: {
      lookup.cancel()
    }
  }

  nonisolated private static func existingIdentifiers(_ ids: [String]) -> Set<String> {
    let opts = PHFetchOptions()
    opts.includeHiddenAssets = true
    opts.includeAllBurstAssets = true
    opts.includeAssetSourceTypes = [.typeUserLibrary, .typeCloudShared, .typeiTunesSynced]
    return stride(from: 0, to: ids.count, by: 500).reduce(into: Set<String>()) { found, offset in
      guard !Task.isCancelled else { return }
      let result = PHAsset.fetchAssets(
        withLocalIdentifiers: Array(ids[offset..<min(offset + 500, ids.count)]), options: opts)
      found.formUnion((0..<result.count).map { result.object(at: $0).localIdentifier })
    }
  }

  nonisolated private static func currentChangeTokenData() -> Data? {
    try? NSKeyedArchiver.archivedData(
      withRootObject: PHPhotoLibrary.shared().currentChangeToken,
      requiringSecureCoding: true)
  }

  // MARK: - Off-Main PhotoKit Enumeration

  /// Every eligible asset with its capture date, newest first (`nil` dates last).
  nonisolated private static func walkPhotoKit(settings: BackupSettings) -> [DiscoveredAsset] {
    let sharedAlbumIDs = sharedAlbumIDsToExclude(settings)
    let images = fetchMediaType(.image, settings: settings, sharedAlbumIDs: sharedAlbumIDs)
    guard !Task.isCancelled else { return [] }
    let videos =
      settings.includeVideos
      ? fetchMediaType(.video, settings: settings, sharedAlbumIDs: sharedAlbumIDs) : []
    guard !Task.isCancelled else { return [] }
    return sortNewestFirst(images + videos)
  }

  nonisolated private static func fetchAssets(
    localIdentifiers ids: [String], settings: BackupSettings
  ) -> [DiscoveredAsset] {
    guard !ids.isEmpty else { return [] }
    let opts = PHFetchOptions()
    opts.predicate =
      settings.includeVideos
      ? NSPredicate(
        format: "mediaType == %d OR mediaType == %d",
        PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
      : NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    return sortNewestFirst(
      eligible(
        PHAsset.fetchAssets(withLocalIdentifiers: ids, options: opts),
        settings: settings, sharedAlbumIDs: sharedAlbumIDsToExclude(settings)))
  }

  nonisolated private static func fetchMediaType(
    _ mediaType: PHAssetMediaType, settings: BackupSettings, sharedAlbumIDs: Set<String>
  ) -> [DiscoveredAsset] {
    let opts = PHFetchOptions()
    opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    return eligible(
      PHAsset.fetchAssets(with: mediaType, options: opts),
      settings: settings, sharedAlbumIDs: sharedAlbumIDs)
  }

  /// Filters `result` by the inclusion settings and seeds the catalog's asset
  /// cache, so the reader's later per-asset lookups need no PhotoKit fetch.
  nonisolated private static func eligible(
    _ result: PHFetchResult<PHAsset>, settings: BackupSettings, sharedAlbumIDs: Set<String>
  ) -> [DiscoveredAsset] {
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
      cacheUpdate[asset.localIdentifier] = asset
      out.append(
        DiscoveredAsset(
          phid: asset.localIdentifier, capturedAt: asset.creationDate,
          possibleCompanions: possibleCompanions(of: asset)))
    }
    PhotoKitCatalog.shared.mergeAssetCache(cacheUpdate)
    return out
  }

  nonisolated private static func sharedAlbumIDsToExclude(
    _ settings: BackupSettings
  ) -> Set<String> {
    settings.includeSharedAlbums ? [] : PhotoKitCatalog.shared.sharedAlbumIdentifiers()
  }

  /// Applies the inclusion settings: videos, non-representative burst
  /// frames, iCloud Shared Library assets and iCloud Shared Album members are
  /// each skipped when their setting is off.
  nonisolated private static func shouldInclude(
    _ asset: PHAsset, settings: BackupSettings, sharedAlbumIDs: Set<String>
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
  /// swallowed.
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
