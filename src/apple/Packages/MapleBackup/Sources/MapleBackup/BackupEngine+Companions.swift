// Sources/MapleBackup/BackupEngine+Companions.swift
//
// Outstanding-companion accounting (#702), split out of BackupEngine.swift to
// keep that file under the 570-line headroom gate (#2311), along with the
// bounded companion retry scheduling. A "companion" is the
// best-effort sidecar / rendered-bytes upload that rides alongside a photo's
// bytes: the photo is done when its bytes land, but the progress VM needs to
// distinguish "uploaded" from "uploaded, companions still pending".

import CryptoKit
import Foundation

extension BackupEngine {
  /// SHA-256 of an uploaded local-edit XMP — the revision recorded in the
  /// backup state store so a newer local edit is distinguishable (#4719).
  static func digest(of xmp: String) -> String {
    SHA256.hash(data: Data(xmp.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  // MARK: - Outstanding-companion accounting (#702)

  /// Record that one more companion for `taskId` has entered its bounded
  /// retry path. Emits `.companionPending` only on the 0→1 transition so the
  /// progress VM flips the photo to "uploaded, companions pending" exactly
  /// once regardless of how many companions are outstanding.
  func companionBecamePending(_ taskId: BackupTaskID) async {
    let prior = outstandingCompanions[taskId] ?? 0
    outstandingCompanions[taskId] = prior + 1
    if prior == 0 {
      await queue.emit(.companionPending(taskId))
    }
  }

  /// Record that one companion for `taskId` reached a terminal state (landed
  /// or exhausted). Emits `.companionsResolved` only on the →0 transition so
  /// the photo flips back to fully "done" exactly once.
  func companionResolved(_ taskId: BackupTaskID) async {
    guard let prior = outstandingCompanions[taskId], prior > 0 else { return }
    if prior == 1 {
      outstandingCompanions.removeValue(forKey: taskId)
      await queue.emit(.companionsResolved(taskId))
    } else {
      outstandingCompanions[taskId] = prior - 1
    }
  }

  /// Exponential backoff capped at 1 hour. The `companionBackoff` default
  /// argument inlines the same formula (a `public` init can't reference a
  /// non-public member in a default value).
  static func backoffSeconds(for retryCount: Int) -> TimeInterval {
    min(3600, pow(2.0, Double(retryCount)))
  }

  // MARK: - Bounded companion retries

  /// Run one companion upload best-effort: try `op` inline once; on failure
  /// schedule a bounded, exponentially-backed-off detached retry (tracked in
  /// `retryTasks` so `stop()` tears it down cleanly). Never throws, never
  /// emits queue events. `busyElsewhere` on a companion is treated like any
  /// other transient failure here — it's coordination on a re-derivable
  /// artifact, not a reason to fail the (already-uploaded) photo.
  func runCompanion(
    taskId: BackupTaskID,
    label: String,
    maxAttempts: Int,
    _ op: @escaping @Sendable () async throws -> Void
  ) async {
    do {
      try await op()
    } catch {
      // Cancelled by stop(): never schedule a retry that outlives the teardown.
      guard !Task.isCancelled else { return }
      Self.companionLog.notice(
        "companion \(label, privacy: .public) first attempt failed, scheduling retry: \(String(describing: error), privacy: .public)"
      )
      // This companion is now outstanding — count it once. The bounded
      // detached retry (and its recursive reschedules) decrement exactly
      // once at the chain's terminus (success or exhaustion). Emit the
      // 0→1 `.companionPending` signal here so the photo flips from "done"
      // to "uploaded, companions pending" in the progress VM (#702).
      await companionBecamePending(taskId)
      scheduleCompanionRetry(
        taskId: taskId, label: label, attempt: 1,
        maxAttempts: maxAttempts, op: op)
    }
  }

  /// Schedule the next bounded companion retry. Detached so it doesn't hold a
  /// `run()` concurrency slot; on exhaustion the re-derivable artifact is
  /// simply dropped (a future safety walk can regenerate it).
  func scheduleCompanionRetry(
    taskId: BackupTaskID,
    label: String,
    attempt: Int,
    maxAttempts: Int,
    op: @escaping @Sendable () async throws -> Void
  ) {
    // Checked on the actor, with no suspension before the insert below: a
    // caller cancelled by stop() while hopping here must not register a retry
    // after stop() took its snapshot.
    guard !Task.isCancelled else { return }
    guard attempt < maxAttempts else {
      Self.companionLog.error(
        "companion \(label, privacy: .public) exhausted \(maxAttempts) attempts — dropping (re-derivable artifacts can be regenerated on a future walk)"
      )
      // Terminal: budget exhausted. Decrement once so a dropped companion
      // doesn't leak as permanently "pending" (#702).
      Task { await self.companionResolved(taskId) }
      return
    }
    let backoff = companionBackoff(attempt)
    let token = UUID()
    let retryTask = Task.detached(priority: .background) { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
      if Task.isCancelled {
        await self?.finishRetry(token)
        return
      }
      do {
        try await op()
        // Terminal: the companion landed on this retry. Decrement once.
        await self?.companionResolved(taskId)
      } catch {
        // Cancelled by stop(): a replacement retry would outlive the teardown.
        guard !Task.isCancelled else {
          await self?.finishRetry(token)
          return
        }
        // Bounded recursion via the actor so retryTasks stays consistent.
        // No re-increment: this companion is already counted outstanding.
        await self?.scheduleCompanionRetry(
          taskId: taskId, label: label,
          attempt: attempt + 1,
          maxAttempts: maxAttempts, op: op)
      }
      // Retire on EVERY exit. A companion retry never enqueues to the
      // upload queue and used to never signal at all, so a `retryTasks`
      // holding only companions parked `run()` on a wake that could not
      // arrive — the 1 s poll used to paper over that.
      await self?.finishRetry(token)
    }
    retryTasks[token] = retryTask
  }
}
