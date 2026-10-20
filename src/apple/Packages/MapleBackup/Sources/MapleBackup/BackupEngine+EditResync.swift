// Sources/MapleBackup/BackupEngine+EditResync.swift
//
// Re-send a newer local PhotoKit edit for a photo the server already holds
// (#4719). The App Support XMP stays the editor's canonical copy; the digest
// recorded after each delivered sidecar tells a newer edit apart. Each re-send
// names that digest as its base, so the server's compare-and-swap lands the
// edit without overwriting a version it was not based on.

import Foundation

/// A photo the server already holds from this device, with where it landed.
public struct ServerHeldAsset: Sendable {
  public let id: BackupTaskID
  public let targetRelPath: String
  public let mapleId: String?

  public init(id: BackupTaskID, targetRelPath: String, mapleId: String?) {
    self.id = id
    self.targetRelPath = targetRelPath
    self.mapleId = mapleId
  }
}

extension BackupEngine {
  /// Sends every local edit that differs from the revision last delivered.
  /// A failed send keeps the old revision recorded, so the next scan retries.
  public func resendNewerEdits(_ assets: [ServerHeldAsset]) async {
    let edited: Set<String>
    do {
      edited = try sidecars.storedSidecarFileNames()
    } catch {
      Self.companionLog.error(
        "edit re-send skipped: local edits unreadable: \(String(describing: error), privacy: .public)"
      )
      return
    }
    let candidates = assets.filter {
      edited.contains(sidecars.sidecarURL(phassetLocalId: $0.id.phassetLocalId).lastPathComponent)
    }
    for asset in candidates {
      guard !Task.isCancelled else { return }
      await resendIfNewer(asset)
    }
  }

  private func resendIfNewer(_ asset: ServerHeldAsset) async {
    do {
      try await sendLatestEdit(
        id: asset.id, targetRelPath: asset.targetRelPath, mapleId: asset.mapleId)
    } catch {
      Self.companionLog.error(
        "edit re-send failed, phasset=\(asset.id.phassetLocalId, privacy: .private): \(String(describing: error), privacy: .public)"
      )
    }
  }

  /// Sends the current local edit unless the server already has it. Both are
  /// read at send time, so a delayed retry never sends an older edit with a
  /// newer revision as its base (#5023).
  func sendLatestEdit(id: BackupTaskID, targetRelPath: String, mapleId: String?) async throws {
    guard let xmp = try sidecars.read(phassetLocalId: id.phassetLocalId) else { return }
    let digest = Self.digest(of: xmp)
    let delivered = try await state.uploadedSidecarDigest(id)
    guard digest != delivered else { return }
    try await upload.uploadSidecar(
      phassetLocalId: id.phassetLocalId,
      targetRelPath: targetRelPath,
      xmp: xmp,
      mapleId: mapleId,
      basedOn: delivered)
    try await state.recordUploadedSidecar(id, digest: digest)
  }
}
