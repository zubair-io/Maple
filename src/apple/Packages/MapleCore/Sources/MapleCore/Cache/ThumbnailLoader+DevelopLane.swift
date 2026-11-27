import Foundation

// Lock order: a develop never holds a decode slot and a develop permit at once.
extension ThumbnailLoader {
  @TaskLocal static var producerID: UUID?
  @TaskLocal static var producerGate: ProducerGate = .decode

  func developRawSidecar(
    at url: URL, targetLongEdge: CGFloat, quality: CGFloat,
    priority: BoundedAsyncSemaphore.Priority = .standard
  ) async throws -> Data? {
    let data = try await developOffSlot(priority: priority) {
      try Self.renderRawSidecarDerivative(
        at: url, targetLongEdge: targetLongEdge, quality: quality)
    }
    guard data == nil, let producer = Self.producerID else { return data }
    // A sidecar that vanished leads to the embedded-preview read, which needs its decode slot.
    try await retakeSlot(producer, gate: Self.producerGate, priority: priority)
    return nil
  }

  func developFallbackThumbnail(at url: URL) async throws -> Data? {
    try await developOffSlot(priority: .standard) {
      let image = try PipelineRenderer.render(rawPath: url, quality: .preview)
      return Self.encodeThumbnail(image, ctx: Self.staticEncodeCIContext)
    }
  }

  nonisolated static func hasRawSidecar(at url: URL) -> Bool {
    do {
      _ = try FileManager.default.attributesOfItem(atPath: SidecarPath.sidecarURL(for: url).path)
      return true
    } catch let error as CocoaError
      where error.code == .fileNoSuchFile
      || error.code == .fileReadNoSuchFile
    {
      return false
    } catch {
      return true
    }
  }

  func developOffSlot<T: Sendable>(
    priority: BoundedAsyncSemaphore.Priority,
    _ work: @escaping @Sendable () throws -> T
  ) async throws -> T {
    let producer = Self.producerID
    if let producer {
      setProducerActive(producer, false)
      await giveBackSlot(producer, gate: Self.producerGate)
      // An active producer is never cancelled when its last consumer leaves, so that is only recorded.
      guard !abandonedProducers.contains(producer) else {
        stopJoining(producer)
        throw CancellationError()
      }
    }
    let isInteractive = priority == .interactive
    let lane = isInteractive ? interactiveDevelopLane : gridDevelopLane
    try await lane.acquire()
    guard !Task.isCancelled else {
      await lane.release()
      throw CancellationError()
    }
    if let producer { setProducerActive(producer, true) }
    let outcome: Result<T, Error>
    do {
      outcome = .success(
        try await BlockingWork.run(qos: isInteractive ? .userInitiated : .utility, work))
    } catch {
      outcome = .failure(error)
    }
    await lane.release()
    return try outcome.get()
  }

  private func giveBackSlot(_ producer: UUID, gate: ProducerGate) async {
    guard slotlessProducers.insert(producer).inserted else { return }
    await slots(for: gate).release()
  }

  private func retakeSlot(
    _ producer: UUID, gate: ProducerGate, priority: BoundedAsyncSemaphore.Priority
  ) async throws {
    guard slotlessProducers.contains(producer) else { return }
    guard !abandonedProducers.contains(producer) else {
      stopJoining(producer)
      throw CancellationError()
    }
    setProducerActive(producer, false)
    let slots = slots(for: gate)
    try await slots.acquire(priority: priority)
    guard !Task.isCancelled else {
      await slots.release()
      throw CancellationError()
    }
    slotlessProducers.remove(producer)
    setProducerActive(producer, true)
  }
}
