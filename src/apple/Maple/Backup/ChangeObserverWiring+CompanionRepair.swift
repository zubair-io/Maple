// src/apple/Maple/Backup/ChangeObserverWiring+CompanionRepair.swift
//
// Before #5777 a photo could be recorded as uploaded after its Live Photo
// video or edited render was dropped, and neither the device nor a reinstall
// could tell (#5778). A full scan compares the companions the server reports
// holding with the ones PhotoKit has, and re-queues each uploaded photo still
// missing one; the engine then re-sends the original, which the server
// dedupes, and its companions. A server that does not report companions
// repairs nothing, and the store re-queues a photo at most once.

import Foundation
import MapleBackup
import MapleCore
import OSLog
import Photos

private let repairLog = Logger(
  subsystem: "app.justmaple.aperture", category: "Backup.CompanionRepair")

extension ChangeObserverWiring {

  /// The companions an asset's subtype and edit state say it may carry. Read
  /// during discovery, so the repair inspects resources only for the few
  /// assets the server lacks something for.
  nonisolated static func possibleCompanions(of asset: PHAsset) -> BackupCompanions {
    BackupCompanions(
      liveVideo: asset.mediaSubtypes.contains(.photoLive), rendered: asset.hasAdjustments)
  }

  /// Re-queues uploaded photos whose Live Photo video or edited render the
  /// server lacks. Returns the photos re-queued, or nil when saving the
  /// re-queue failed, which fails the walk.
  static func repairMissingCompanions(
    _ assets: [DiscoveredAsset], deviceId: String, settings: BackupSettings,
    serverCompanions: [String: BackupCompanions],
    state: BackupStateStore, queue: any BackupQueue
  ) async -> Set<String>? {
    let includeLivePhotos = settings.includeLivePhotos
    do {
      let requeued = try await CompanionRepair.requeueMissing(
        possible: Dictionary(
          assets.map { ($0.phid, $0.possibleCompanions) }, uniquingKeysWith: { first, _ in first }),
        held: serverCompanions, includeLivePhotos: includeLivePhotos, deviceId: deviceId,
        capturedAt: Dictionary(
          assets.compactMap { asset in asset.capturedAt.map { (asset.phid, $0) } },
          uniquingKeysWith: { first, _ in first }),
        state: state, queue: queue,
        onDevice: { candidates in
          let lookup = Task.detached(priority: .utility) {
            companionsOnDevice(of: candidates, includeLivePhotos: includeLivePhotos)
          }
          return await withTaskCancellationHandler {
            await lookup.value
          } onCancel: {
            lookup.cancel()
          }
        })
      repairLog.info("companion repair requeued \(requeued.count) photos")
      return requeued
    } catch {
      BackupIssueStatus.log(.error, "Backup state write failed: \(error)")
      EngineHost.shared.progress.setWalkPhase(
        .failed("couldn't save local backup records. Details are in the logs."))
      return nil
    }
  }

  /// The companions each asset has on this device, by the same rule the
  /// reader uses to upload them: the full-size edit, and the paired video of
  /// a Live Photo when Live Photos are included.
  nonisolated private static func companionsOnDevice(
    of phids: Set<String>, includeLivePhotos: Bool
  ) -> [String: BackupCompanions] {
    let ids = Array(phids)
    let batches = stride(from: 0, to: ids.count, by: 500).map {
      Array(ids[$0..<min($0 + 500, ids.count)])
    }
    return batches.reduce(into: [:]) { found, batch in
      guard !Task.isCancelled else { return }
      let result = PHAsset.fetchAssets(withLocalIdentifiers: batch, options: nil)
      for asset in (0..<result.count).map(result.object(at:)) {
        guard !Task.isCancelled else { return }
        let types = Set(PHAssetResource.assetResources(for: asset).map(\.type))
        let liveVideo =
          includeLivePhotos && asset.mediaSubtypes.contains(.photoLive)
          && types.contains(.pairedVideo)
        found[asset.localIdentifier] = BackupCompanions(
          liveVideo: liveVideo, rendered: types.contains(.fullSizePhoto))
      }
    }
  }
}
