import Foundation
import XCTest

@testable import MapleCore

final class RemovalProxyTensorTests: XCTestCase {
  func testChannelOrderScaleAndPaddingAreModelInputsNotColorEdits() throws {
    let proxy = NativeRemovalRender(width: 1, height: 1, bytes: Data([255, 128, 0]))
    let tensors = try NativeRemovalProxyTensors(proxy, width: 16, height: 8)
    XCTAssertEqual(tensors.inputWidth, 16)
    XCTAssertEqual(tensors.inputHeight, 8)
    let plane = 1024 * 1024
    XCTAssertEqual(tensors.encoder.count, 3 * plane)
    XCTAssertEqual(tensors.encoder[0], 255)
    XCTAssertEqual(tensors.encoder[plane], 128)
    XCTAssertEqual(tensors.encoder[plane * 2], 0)
    XCTAssertEqual(tensors.encoder[7 * 1024 + 15], 255)
    XCTAssertEqual(tensors.encoder[8 * 1024], 0)
    XCTAssertEqual(tensors.encoder[16], 0)
    let detectorPlane = 640 * 640
    XCTAssertEqual(tensors.detector.count, 3 * detectorPlane)
    XCTAssertEqual(tensors.detector[detectorPlane - 1], 1)
    XCTAssertEqual(tensors.detector[detectorPlane * 2 - 1], Float(128) / 255)
    XCTAssertEqual(tensors.detector.last, 0)
  }

  func testLargePortraitMaintainsAspectAndPadsInsteadOfStretchingEncoder() throws {
    let proxy = NativeRemovalRender(width: 1, height: 1, bytes: Data([1, 2, 3]))
    let tensors = try NativeRemovalProxyTensors(proxy, width: 5000, height: 10000)
    XCTAssertEqual(tensors.inputWidth, 512)
    XCTAssertEqual(tensors.inputHeight, 1024)
    XCTAssertEqual(tensors.encoder[511], 1)
    XCTAssertEqual(tensors.encoder[512], 0)
    XCTAssertEqual(tensors.encoder[1023 * 1024 + 511], 1)
    XCTAssertEqual(tensors.encoder[1023 * 1024 + 512], 0)
  }

  func testMalformedProxyFailsBeforeModelPreparation() {
    XCTAssertThrowsError(
      try NativeRemovalProxyTensors(
        NativeRemovalRender(width: 2, height: 1, bytes: Data([1, 2, 3])), width: 16, height: 8))
    XCTAssertThrowsError(
      try NativeRemovalProxyTensors(
        NativeRemovalRender(width: 1, height: 1, bytes: Data([1, 2, 3])), width: 0, height: 8))
  }
}
