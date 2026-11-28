// Value type with no locking of its own; the owner supplies isolation.

struct RecencyOrderedStore<Key: Hashable, Value> {
  private struct Slot {
    var key: Key
    var value: Value
    var newer: Int
    var older: Int
  }

  private static var none: Int { -1 }

  private let capacity: Int
  private var slots: [Slot?] = []
  private var vacant: [Int] = []
  private var index: [Key: Int] = [:]
  private var newest = RecencyOrderedStore.none
  private var oldest = RecencyOrderedStore.none

  init(capacity: Int) {
    self.capacity = max(1, capacity)
  }

  var count: Int { index.count }

  var oldestKey: Key? { oldest == Self.none ? nil : slots[oldest]?.key }

  var keysOldestFirst: [Key] {
    var keys: [Key] = []
    var cursor = oldest
    while cursor != Self.none, let slot = slots[cursor] {
      keys.append(slot.key)
      cursor = slot.newer
    }
    return keys
  }

  func peek(_ key: Key) -> Value? {
    index[key].flatMap { slots[$0]?.value }
  }

  mutating func touch(_ key: Key) -> Value? {
    guard let slot = index[key] else { return nil }
    moveToNewest(slot)
    return slots[slot]?.value
  }

  /// Replacing an existing key evicts nothing; adding to a full store returns the evicted key.
  @discardableResult
  mutating func set(_ value: Value, for key: Key) -> Key? {
    if let slot = index[key] {
      slots[slot]?.value = value
      moveToNewest(slot)
      return nil
    }
    let evicted = index.count >= capacity ? removeOldest() : nil
    let slot = vacant.popLast() ?? slots.count
    let entry = Slot(key: key, value: value, newer: Self.none, older: Self.none)
    if slot == slots.count { slots.append(entry) } else { slots[slot] = entry }
    index[key] = slot
    linkAsNewest(slot)
    return evicted
  }

  mutating func remove(_ key: Key) {
    guard let slot = index.removeValue(forKey: key) else { return }
    unlink(slot)
    slots[slot] = nil
    vacant.append(slot)
  }

  @discardableResult
  mutating func removeOldest() -> Key? {
    guard oldest != Self.none, let key = slots[oldest]?.key else { return nil }
    remove(key)
    return key
  }

  private mutating func moveToNewest(_ slot: Int) {
    guard slot != newest else { return }
    unlink(slot)
    linkAsNewest(slot)
  }

  private mutating func linkAsNewest(_ slot: Int) {
    slots[slot]?.older = newest
    slots[slot]?.newer = Self.none
    if newest != Self.none { slots[newest]?.newer = slot }
    newest = slot
    if oldest == Self.none { oldest = slot }
  }

  private mutating func unlink(_ slot: Int) {
    guard let entry = slots[slot] else { return }
    if entry.older != Self.none {
      slots[entry.older]?.newer = entry.newer
    } else {
      oldest = entry.newer
    }
    if entry.newer != Self.none {
      slots[entry.newer]?.older = entry.older
    } else {
      newest = entry.older
    }
  }
}
