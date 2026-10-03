import Foundation

// Coalesced thumbnail consumers share a producer but own their cancellation.
extension ThumbnailLoader {
  func awaitThumbnail(_ task: Task<Data?, Never>) async -> Data? {
    let waiter = UUID()
    thumbnailWaiters[task, default: []].insert(waiter)
    return await withTaskCancellationHandler {
      let result = await task.value
      finishWaiting(task, waiter: waiter, cancelled: false)
      return Task.isCancelled ? nil : result
    } onCancel: {
      Task { await self.finishWaiting(task, waiter: waiter, cancelled: true) }
    }
  }

  private func finishWaiting(_ task: Task<Data?, Never>, waiter: UUID, cancelled: Bool) {
    guard thumbnailWaiters[task]?.remove(waiter) != nil else { return }
    guard thumbnailWaiters[task]?.isEmpty == true else { return }
    thumbnailWaiters.removeValue(forKey: task)
    if cancelled { task.cancel() }
  }

}
