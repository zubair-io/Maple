import XCTest

final class CIEDE2000BiasTests: XCTestCase {
  func testLargeRepeatedImagePreservesEachChannelsBias() throws {
    let candidate: [UInt8] = [128, 126, 129, 255]
    let reference: [UInt8] = [127, 127, 127, 255]
    let single = try compare(candidate, reference, width: 1, height: 1)
    let repeated = try compare(
      Array(repeating: candidate, count: 512 * 512).flatMap { $0 },
      Array(repeating: reference, count: 512 * 512).flatMap { $0 },
      width: 512, height: 512)
    XCTAssertEqual(repeated.nPixels, 512 * 512)
    for (channel, actual) in [repeated.biasR, repeated.biasG, repeated.biasB].enumerated() {
      // The Python reference normalizes/subtracts in Float, then averages in Double.
      let expected = Double(Float(candidate[channel]) / 255 - Float(reference[channel]) / 255)
      XCTAssertEqual(actual, expected, accuracy: 1e-12)
    }
    assertBias(repeated, equals: [single.biasR, single.biasG, single.biasB])
  }

  func testLargeSignedCancellationIsIndependentOfPixelOrder() throws {
    let positiveCandidate: [UInt8] = [255, 255, 255, 255]
    let positiveReference: [UInt8] = [1, 1, 1, 255]
    let negativeCandidate: [UInt8] = [0, 0, 0, 255]
    let negativeReference: [UInt8] = [253, 253, 253, 255]
    let positive = Double(Float(255) / 255 - Float(1) / 255)
    let negative = Double(Float(0) / 255 - Float(253) / 255)
    let expected = Array(repeating: (positive + negative) / 2, count: 3)
    let half = 512 * 256
    for reverse in [false, true] {
      let candidates =
        reverse
        ? [negativeCandidate, positiveCandidate] : [positiveCandidate, negativeCandidate]
      let references =
        reverse
        ? [negativeReference, positiveReference] : [positiveReference, negativeReference]
      let result = try compare(
        candidates.flatMap { Array(repeating: $0, count: half).flatMap { $0 } },
        references.flatMap { Array(repeating: $0, count: half).flatMap { $0 } },
        width: 512, height: 512)
      XCTAssertEqual(result.nPixels, 512 * 512)
      assertBias(result, equals: expected)
    }
  }

  private func compare(_ candidate: [UInt8], _ reference: [UInt8], width: Int, height: Int) throws
    -> CIEDE2000Result
  {
    try XCTUnwrap(
      CIEDE2000.compare(
        candidateRGBA: candidate, referenceRGBA: reference, width: width, height: height))
  }

  private func assertBias(
    _ result: CIEDE2000Result, equals expected: [Double],
    file: StaticString = #filePath, line: UInt = #line
  ) {
    for (actual, expected) in zip([result.biasR, result.biasG, result.biasB], expected) {
      XCTAssertEqual(actual, expected, accuracy: 1e-12, file: file, line: line)
    }
  }
}
