// Sources/MapleBackup/BackupEngine+Recovery.swift
//
// Durable local-edit companion replay for already-uploaded photos.

import Foundation
import os

private enum SidecarDeliveryError: Error {
  case changedDuringUpload
}

extension BackupEngine {
  /// Replay only local-edit XMP whose primary bytes are already uploaded.
  /// Hosts call this after opening their destination-scoped state database.
  public func recoverPendingSidecars() async {
    do {
      for receipt in try await state.pendingSidecars(deviceId: await upload.backupDeviceId()) {
        if Task.isCancelled { return }
        do {
          guard try sidecars.read(phassetLocalId: receipt.id.phassetLocalId) != nil else {
            // An acknowledged upload can crash between deleting its XMP and
            // clearing the receipt. There is nothing left to resend.
            try await state.clearPendingSidecar(receipt.id)
            continue
          }
        } catch {
          Self.companionLog.error(
            "pending sidecar read failed: \(String(describing: error), privacy: .public)")
          continue
        }
        await runCompanion(
          taskId: receipt.id, label: "sidecar", maxAttempts: Self.localEditCompanionRetries
        ) { [self] in
          try await deliverSidecar(receipt)
        }
      }
    } catch {
      Self.companionLog.error(
        "pending sidecar recovery failed: \(String(describing: error), privacy: .public)")
    }
  }

  func deliverSidecar(_ receipt: BackupStateStore.PendingSidecar) async throws {
    try Task.checkCancellation()
    guard let xmp = try sidecars.read(phassetLocalId: receipt.id.phassetLocalId) else {
      throw CocoaError(.fileNoSuchFile)
    }
    try await upload.uploadSidecar(
      phassetLocalId: receipt.id.phassetLocalId,
      targetRelPath: receipt.targetRelPath, xmp: xmp, mapleId: receipt.mapleId)
    try Task.checkCancellation()
    if try sidecars.read(phassetLocalId: receipt.id.phassetLocalId) == xmp {
      try sidecars.delete(phassetLocalId: receipt.id.phassetLocalId)
      try await state.clearPendingSidecar(receipt.id)
    } else {
      // A newer local edit arrived while the request was in flight. Keep
      // the durable receipt and retry with the current file on next start.
      throw SidecarDeliveryError.changedDuringUpload
    }
  }

}
