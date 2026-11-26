import Foundation

// Lock order: a develop never holds a decode slot and a develop permit at once.
extension ThumbnailLoader {
  @TaskLocal static var producerID: UUID?
  @TaskLocal static var producerGate: ProducerGate = .decode

  func developRawSidecar(
    at url: URL, targetLongEdge: CGFloat, quality: CGFloat,
    priority: BoundedAsyncSemaphore.Priority = .standard
  ) async throws -> Data? {
    try await developOffSlot(priority: priority) {
      try Self.renderRawSidecarDerivative(
        at: url, targetLongEdge: targetLongEdge, quality: quality)
    }
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
    }
    let isInteractive = priority == .interactive
    let lane = isInteractive ? interactiveDevelopLane : gridDevelopLane
    try await lane.acquire()
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
}
