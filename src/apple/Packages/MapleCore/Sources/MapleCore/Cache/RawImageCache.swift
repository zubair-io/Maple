// Single-entry rawler handle cache for deep-zoom tiles. Initial viewport
// decoding uses RenderActor's separate scene-linear image cache.
import Foundation

public actor RawImageCache {
  public static let shared = RawImageCache()

  private struct Key: Hashable {
    let url: URL
    let mtime: Date
  }
  private struct Entry {
    let key: Key
    let handle: MapleRawHandle
  }
  private struct Pending {
    let generation: UInt64
    let task: Task<MapleRawHandle, Error>
  }

  private var current: Entry?
  private var requestedKey: Key?
  private var generation: UInt64 = 0
  private var pendingDecodes: [Key: Pending] = [:]
  private let decodeSlot = BoundedAsyncSemaphore(value: 1)
  private let decode: @Sendable (URL) async throws -> MapleRawHandle

  public init() {
    decode = { try PipelineRenderer.openRawHandle(rawPath: $0, xmpPath: nil) }
  }

  /// Tests delay a real native handle open to exercise eviction races.
  init(decode: @escaping @Sendable (URL) async throws -> MapleRawHandle) {
    self.decode = decode
  }

  /// Same-asset tiles share one decode. Different assets serialize their
  /// native opens, with superseded queued requests dropped before reading a
  /// RAW. A completed obsolete request can satisfy its original caller but
  /// cannot repopulate an evicted cache or replace a more recent asset.
  public func handle(for url: URL) async throws -> MapleRawHandle {
    try Task.checkCancellation()
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let key = Key(url: url, mtime: attributes[.modificationDate] as? Date ?? .distantPast)
    if let current, current.key == key { return current.handle }
    if requestedKey != key {
      generation &+= 1
      requestedKey = key
      current = nil
    }
    let requestGeneration = generation
    if let pending = pendingDecodes[key], pending.generation == requestGeneration {
      let handle = try await pending.task.value
      try Task.checkCancellation()
      return handle
    }
    let task = Task.detached(priority: .userInitiated) { [decode, decodeSlot, self] in
      try await decodeSlot.acquire()
      do {
        guard await isCurrent(key, generation: requestGeneration) else {
          throw CancellationError()
        }
        let handle = try await decode(url)
        await decodeSlot.release()
        return handle
      } catch {
        await decodeSlot.release()
        throw error
      }
    }
    pendingDecodes[key] = Pending(generation: requestGeneration, task: task)
    do {
      let handle = try await task.value
      if isCurrent(key, generation: requestGeneration) {
        current = Entry(key: key, handle: handle)
      }
      removePending(key, generation: requestGeneration)
      try Task.checkCancellation()
      return handle
    } catch {
      removePending(key, generation: requestGeneration)
      throw error
    }
  }

  public func evict() {
    generation &+= 1
    requestedKey = nil
    current = nil
  }

  public var cachedURL: URL? { current?.key.url }

  private func isCurrent(_ key: Key, generation requestGeneration: UInt64) -> Bool {
    generation == requestGeneration && requestedKey == key
  }

  private func removePending(_ key: Key, generation requestGeneration: UInt64) {
    guard pendingDecodes[key]?.generation == requestGeneration else { return }
    pendingDecodes.removeValue(forKey: key)
  }
}
