import Foundation
import XCTest

@testable import MapleCore

extension SceneLinearChainCacheTests {
  func testUnchangedNumbersWithDifferentWBAuthorshipInvalidateCachedPixels() {
    let id = UUID()
    func key(_ model: AdjustmentModel) -> SceneLinearChainCache.Key {
      SceneLinearChainCache.make(
        assetID: id, model: model, decodedTemperature: 5520, decodedTint: -12,
        skipAgX: false, width: 16, height: 8)
    }
    var absent = AdjustmentModel.default
    absent.temperatureSeen = false
    absent.tintSeen = false
    let asShot = key(absent)
    var temperature = absent
    temperature.temperature = absent.temperature
    var tint = absent
    tint.tint = absent.tint
    XCTAssertNotEqual(asShot, key(temperature))
    XCTAssertNotEqual(asShot, key(tint))
    XCTAssertNotEqual(key(temperature), key(tint))
  }
}
