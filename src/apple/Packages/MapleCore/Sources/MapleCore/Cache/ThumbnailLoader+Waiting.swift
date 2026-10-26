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

  func startLocalProducer(
    key: String,
    operation: @escaping @Sendable () async -> Data?
  ) -> Task<Data?, Never> {
    let producerID = UUID()
    let task = Task.detached(priority: .utility) { () -> Data? in
      do {
        try await self.beginActiveProducer(producerID)
      } catch {
        await self.cleanupLocalProducer(producerID, key: key)
        return nil
      }
      let result = await operation()
      await self.endActiveProducer(producerID, key: key)
      return result
    }
    taskProducerIDs[task] = producerID
    inFlight[key] = task
    return task
  }

  private func beginActiveProducer(_ id: UUID) async throws {
    try await acquireDecodeSlot()
    activeProducers.insert(id)
  }

  private func cleanupLocalProducer(_ id: UUID, key: String) {
    activeProducers.remove(id)
    if let task = inFlight[key], taskProducerIDs[task] == id {
      inFlight.removeValue(forKey: key)
    }
    taskProducerIDs = taskProducerIDs.filter { $0.value != id }
  }

  private func endActiveProducer(_ id: UUID, key: String) async {
    cleanupLocalProducer(id, key: key)
    await releaseDecodeSlot()
  }

  private func isProducerActive(_ task: Task<Data?, Never>) -> Bool {
    guard let id = taskProducerIDs[task] else { return false }
    return activeProducers.contains(id)
  }

  private func finishWaiting(_ task: Task<Data?, Never>, waiter: UUID, cancelled: Bool) {
    guard thumbnailWaiters[task]?.remove(waiter) != nil else { return }
    guard thumbnailWaiters[task]?.isEmpty == true else { return }
    thumbnailWaiters.removeValue(forKey: task)
    if cancelled, !isProducerActive(task) {
      task.cancel()
      taskProducerIDs.removeValue(forKey: task)
    }
  }

}
