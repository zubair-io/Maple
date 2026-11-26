import XCTest

@testable import MapleCore

final class RecencyOrderedStoreTests: XCTestCase {

  func testTouchRefreshesRecencyAndPeekDoesNot() {
    var store = RecencyOrderedStore<String, Int>(capacity: 3)
    store.set(1, for: "a")
    store.set(2, for: "b")
    store.set(3, for: "c")
    XCTAssertEqual(store.peek("a"), 1)
    XCTAssertEqual(store.keysOldestFirst, ["a", "b", "c"], "peek must not refresh")
    XCTAssertEqual(store.touch("a"), 1)
    XCTAssertEqual(store.keysOldestFirst, ["b", "c", "a"])
    XCTAssertNil(store.touch("missing"))
  }

  func testEvictsLeastRecentlyUsedFirst() {
    var store = RecencyOrderedStore<String, Int>(capacity: 3)
    for (offset, key) in ["a", "b", "c"].enumerated() { store.set(offset, for: key) }
    _ = store.touch("a")
    XCTAssertEqual(store.set(9, for: "d"), "b")
    XCTAssertEqual(store.set(9, for: "e"), "c")
    XCTAssertEqual(store.keysOldestFirst, ["a", "d", "e"])
    XCTAssertEqual(store.count, 3)
  }

  func testReplacingAKeyEvictsNothingAndKeepsTheCount() {
    var store = RecencyOrderedStore<String, Int>(capacity: 2)
    store.set(1, for: "a")
    store.set(2, for: "b")
    XCTAssertNil(store.set(10, for: "a"))
    XCTAssertEqual(store.count, 2)
    XCTAssertEqual(store.peek("a"), 10)
    XCTAssertEqual(store.keysOldestFirst, ["b", "a"], "a replaced key becomes most recent")
  }

  func testRemoveFreesTheSlotAndLeavesOrderIntact() {
    var store = RecencyOrderedStore<String, Int>(capacity: 4)
    for (offset, key) in ["a", "b", "c", "d"].enumerated() { store.set(offset, for: key) }
    store.remove("b")
    store.remove("b")
    XCTAssertEqual(store.keysOldestFirst, ["a", "c", "d"])
    XCTAssertNil(store.set(7, for: "e"), "a freed slot means no eviction")
    XCTAssertEqual(store.keysOldestFirst, ["a", "c", "d", "e"])
    XCTAssertEqual(store.removeOldest(), "a")
    XCTAssertEqual(store.removeOldest(), "c")
    XCTAssertEqual(store.removeOldest(), "d")
    XCTAssertEqual(store.removeOldest(), "e")
    XCTAssertNil(store.removeOldest())
    XCTAssertEqual(store.count, 0)
  }

  func testCapacityOfOneAlwaysHoldsTheLatestEntry() {
    var store = RecencyOrderedStore<Int, String>(capacity: 1)
    XCTAssertNil(store.set("x", for: 1))
    XCTAssertEqual(store.set("y", for: 2), 1)
    XCTAssertEqual(store.keysOldestFirst, [2])
    var clamped = RecencyOrderedStore<Int, Int>(capacity: 0)
    clamped.set(1, for: 1)
    clamped.set(2, for: 2)
    XCTAssertEqual(clamped.keysOldestFirst, [2])
  }

  func testLargeValueIsStoredLikeAnyOtherAndEvictedInOrder() {
    var store = RecencyOrderedStore<Int, Data>(capacity: 2)
    let huge = Data(count: 8 * 1024 * 1024)
    store.set(Data([1]), for: 0)
    store.set(huge, for: 1)
    XCTAssertEqual(store.peek(1)?.count, huge.count)
    XCTAssertEqual(store.set(Data([2]), for: 2), 0)
    XCTAssertEqual(store.set(Data([3]), for: 3), 1)
    XCTAssertEqual(store.count, 2)
  }

  func testRandomOperationsMatchAReferenceModelWithoutDrift() {
    let capacity = 37
    var generator = SplitMix64(seed: 0x6037)
    var store = RecencyOrderedStore<Int, Int>(capacity: capacity)
    var model: [(key: Int, value: Int)] = []

    for step in 0..<20_000 {
      let key = Int(generator.next() % 90)
      switch generator.next() % 5 {
      case 0, 1:
        let evicted = store.set(step, for: key)
        let expectedEvicted: Int?
        if let at = model.firstIndex(where: { $0.key == key }) {
          model.remove(at: at)
          expectedEvicted = nil
        } else if model.count >= capacity {
          expectedEvicted = model.removeFirst().key
        } else {
          expectedEvicted = nil
        }
        model.append((key, step))
        XCTAssertEqual(evicted, expectedEvicted, "step \(step)")
      case 2, 3:
        let touched = store.touch(key)
        let at = model.firstIndex { $0.key == key }
        XCTAssertEqual(touched, at.map { model[$0].value }, "step \(step)")
        if let at { model.append(model.remove(at: at)) }
      default:
        store.remove(key)
        let at = model.firstIndex { $0.key == key }
        if let at { model.remove(at: at) }
      }
      XCTAssertEqual(store.count, model.count, "step \(step)")
      XCTAssertLessThanOrEqual(store.count, capacity)
      if step % 500 == 0 { XCTAssertEqual(store.keysOldestFirst, model.map(\.key)) }
    }
    XCTAssertEqual(store.keysOldestFirst, model.map(\.key))
  }
}
