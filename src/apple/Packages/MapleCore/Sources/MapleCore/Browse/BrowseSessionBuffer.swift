// Sources/MapleCore/Browse/BrowseSessionBuffer.swift
//
// Holds the edit sessions that scrolling a Browse grid creates, outside the
// shell's shared `sessions` dictionary. Every visible cell reads that
// dictionary for its badges, so each insertion re-evaluated all of them: a
// reopened 2,000-photo scroll dropped 407 of 623 frames, and 2 with the
// sessions created but not inserted (#6130). Each key has its own observed
// slot, so staging one photo's session re-evaluates only that photo's cell.

import Observation

@MainActor
public final class BrowseSessionBuffer<Key: Hashable, Session: AnyObject> {
  @Observable
  fileprivate final class Slot {
    var session: Session?
  }

  private var slots: [Key: Slot] = [:]
  private var stagedKeys: Set<Key> = []
  private var scheduledDrain: Task<Void, Never>?

  public init() {}

  public func session(for key: Key) -> Session? {
    slot(for: key).session
  }

  public func stage(_ session: Session, for key: Key) {
    slot(for: key).session = session
    stagedKeys.insert(key)
  }

  public func take(_ key: Key) -> Session? {
    guard stagedKeys.remove(key) != nil else { return nil }
    return slots[key]?.session
  }

  public func drain() -> [Key: Session] {
    let staged = stagedKeys
    stagedKeys = []
    return staged.reduce(into: [:]) { result, key in
      result[key] = slots[key]?.session
    }
  }

  /// Hands every staged session to `deliver` once `delay` has passed without
  /// another call, so a continuous scroll delivers nothing and a pause
  /// delivers once. The timer lives here, not in view state: a view-state
  /// write per staged cell is the whole-grid update this type exists to avoid.
  public func drainWhenQuiet(
    after delay: Duration, _ deliver: @escaping @MainActor @Sendable ([Key: Session]) -> Void
  ) {
    scheduledDrain?.cancel()
    scheduledDrain = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled, let staged = self?.drain(), !staged.isEmpty else { return }
      deliver(staged)
    }
  }

  public func remove(_ key: Key) {
    stagedKeys.remove(key)
    slots.removeValue(forKey: key)?.session = nil
  }

  public func removeAll(keeping keys: Set<Key>) {
    let dropped = slots.keys.filter { !keys.contains($0) }
    dropped.forEach(remove)
  }

  private func slot(for key: Key) -> Slot {
    if let existing = slots[key] { return existing }
    let created = Slot()
    slots[key] = created
    return created
  }
}
