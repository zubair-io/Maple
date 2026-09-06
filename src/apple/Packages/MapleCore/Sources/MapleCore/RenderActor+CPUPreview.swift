import CoreImage
import Foundation

extension RenderActor {
  // The synchronous CPU FFI cannot be interrupted once entered. Keep its
  // permit until it returns, even when a newer slider tick cancels the caller.
  // This also bounds work across sessions during an image switch (#3363).
  private static let cpuPreviewSlot = BoundedAsyncSemaphore(value: 1)

  func _testCPUPreviewQueuedCount() async -> Int {
    await Self.cpuPreviewSlot.queuedCount
  }

  func renderCPUPreview(_ work: @escaping @Sendable () -> CIImage) async throws -> CIImage {
    try await Self.cpuPreviewSlot.acquire()
    do {
      try Task.checkCancellation()
      let image = await Task.detached(priority: .userInitiated, operation: work).value
      try Task.checkCancellation()
      await Self.cpuPreviewSlot.release()
      return image
    } catch {
      await Self.cpuPreviewSlot.release()
      throw error
    }
  }
}
