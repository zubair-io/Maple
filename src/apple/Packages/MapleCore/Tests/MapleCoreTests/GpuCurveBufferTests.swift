import XCTest

@testable import MapleCore

final class GpuCurveBufferTests: XCTestCase {
  func testWarmCurveKeepsItsStorageAndAnEditDoesNotMutateTheOldBuffer() {
    var cache = GpuCurveBuffer()
    let original = ToneCurve(points: [(x: 0.2, y: 0.3)])
    let first = cache.resolve(original)
    for _ in 0..<100 {
      let warm = cache.resolve(original)
      first.withUnsafeBufferPointer { a in
        warm.withUnsafeBufferPointer { b in XCTAssertEqual(a.baseAddress, b.baseAddress) }
      }
    }
    let changed = cache.resolve(ToneCurve(points: [(x: 0.2, y: 0.5)]))
    XCTAssertEqual(first, [0.2, 0.3])
    XCTAssertEqual(changed, [0.2, 0.5])
    XCTAssertEqual(cache.resolve(ToneCurve()), [])
  }
}
