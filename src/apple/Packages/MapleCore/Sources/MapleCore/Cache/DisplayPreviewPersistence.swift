import CoreImage
import Foundation

/// Owns the developed-preview debounce, pending frame and all in-flight writes.
/// Model/session validity belongs to EditSession; encoding stays off MainActor.
@MainActor
final class DisplayPreviewPersistence {
  static let idleDebounce: Duration = .milliseconds(1_500)

  private let sink: (any DisplayPreviewSink)?
  private let encode: @Sendable (CIImage) -> Data?
  private var pendingImage: CIImage?
  private var idleTask: Task<Void, Never>?
  private var writeTask: Task<Void, Never>?
  private var writeGeneration: UInt64 = 0

  var hasDestination: Bool { sink != nil }
  var hasPendingImage: Bool { pendingImage != nil }

  init(
    sink: (any DisplayPreviewSink)?,
    encode: @escaping @Sendable (CIImage) -> Data? = {
      ThumbnailLoader.encodeDisplayPreview(from: $0)
    }
  ) {
    self.sink = sink
    self.encode = encode
  }

  deinit { idleTask?.cancel() }

  func schedule(_ image: CIImage) {
    guard sink != nil else { return }
    pendingImage = image
    idleTask?.cancel()
    idleTask = Task { [weak self] in
      try? await Task.sleep(for: Self.idleDebounce)
      guard !Task.isCancelled else { return }
      await self?.persistPending(while: { !Task.isCancelled })
    }
  }

  /// Cancelling a timer cannot stop a detached encode or a sink write. Keep
  /// those handles independently, including when a newer timer replaces one.
  func cancelAndJoin() async {
    repeat {
      let idle = idleTask
      idleTask = nil
      idle?.cancel()
      await idle?.value
      await joinWrites()
      if idleTask == nil { return }
      // A render may have scheduled another capture while either await ran.
    } while true
  }

  func discardPendingImage() { pendingImage = nil }

  /// The caller has accepted the GPU readback. Drain CPU work once more after
  /// cache/thumbnail awaits so an older encode cannot overwrite this frame.
  func persistFinal(_ image: CIImage, while isCurrent: @escaping @MainActor @Sendable () -> Bool)
    async
  {
    await cancelAndJoin()
    guard isCurrent(), sink != nil else { return }
    pendingImage = image
    await persistPending(while: isCurrent)
  }

  func persistPending(while isCurrent: @escaping @MainActor @Sendable () -> Bool = { true }) async {
    // Wait before consuming the image: captures during a slow write still
    // coalesce into one latest pending frame instead of queuing old images.
    await joinWrites()
    guard isCurrent(), let sink, let image = pendingImage else { return }
    pendingImage = nil
    writeGeneration &+= 1
    let generation = writeGeneration
    let encode = encode
    let writing = Task { @MainActor in
      guard isCurrent() else { return }
      let data = await Task.detached(priority: .utility) { encode(image) }.value
      guard let data, isCurrent() else { return }
      await sink.write(data)
    }
    writeTask = writing
    await writing.value
    if generation == writeGeneration { writeTask = nil }
  }

  private func joinWrites() async {
    while let writing = writeTask {
      let generation = writeGeneration
      await writing.value
      // Another waiter may already have started the newest pending frame.
      if generation == writeGeneration { writeTask = nil }
    }
  }

}
