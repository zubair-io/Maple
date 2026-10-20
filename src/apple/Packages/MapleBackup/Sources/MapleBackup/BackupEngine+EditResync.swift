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

  /// Sends the current local edit unless the server already has it. Sends for
  /// one photo run one at a time and read the delivered revision before the
  /// edit, so a slower send can never land an older edit, or record one, over
  /// a newer send (#5023).
  func sendLatestEdit(id: BackupTaskID, targetRelPath: String, mapleId: String?) async throws {
    let previous = sidecarSends[id]
    let send = Task {
      if let previous { await waitUnlessCancelled(for: previous) }
      try await sendLatestEditNow(id: id, targetRelPath: targetRelPath, mapleId: mapleId)
    }
    sidecarSends[id] = send
    defer { if sidecarSends[id] == send { sidecarSends[id] = nil } }
    try await withTaskCancellationHandler {
      try await send.value
    } onCancel: {
      send.cancel()
    }
  }

  private func sendLatestEditNow(
    id: BackupTaskID, targetRelPath: String, mapleId: String?
  ) async throws {
    try Task.checkCancellation()
    let delivered = try await state.uploadedSidecarDigest(id)
    guard let xmp = try sidecars.read(phassetLocalId: id.phassetLocalId) else { return }
    let digest = Self.digest(of: xmp)
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

/// Waits for `previous` to finish, or returns as soon as the calling task is
/// cancelled: a cancelled send must not keep Stop waiting on a stalled request
/// queued ahead of it (#5023).
private func waitUnlessCancelled(for previous: Task<Void, Error>) async {
  let gate = OnceGate()
  await withTaskCancellationHandler {
    await withCheckedContinuation { continuation in
      gate.arm(continuation)
      Task {
        _ = await previous.result
        gate.open()
      }
    }
  } onCancel: {
    gate.open()
  }
}

/// Resumes its continuation exactly once, whichever side opens it first.
private final class OnceGate: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?
  private var opened = false

  func arm(_ continuation: CheckedContinuation<Void, Never>) {
    lock.lock()
    guard !opened else {
      lock.unlock()
      continuation.resume()
      return
    }
    self.continuation = continuation
    lock.unlock()
  }

  func open() {
    lock.lock()
    opened = true
    let waiting = continuation
    continuation = nil
    lock.unlock()
    waiting?.resume()
  }
}
