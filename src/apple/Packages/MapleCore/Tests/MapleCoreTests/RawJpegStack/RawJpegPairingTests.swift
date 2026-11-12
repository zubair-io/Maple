import XCTest

@testable import MapleCore

/// #5050: the name-based pairing mirrors `library/raw-jpeg-stack.ts`.
final class RawJpegPairingTests: XCTestCase {
  func testASameStemRawAndJpegPair() {
    let pairs = RawJpegPairing.pairs(in: ["/a/IMG_1.CR3", "/a/IMG_1.JPG", "/a/IMG_2.CR3"])

    XCTAssertEqual(pairs, ["/a/IMG_1.CR3": "/a/IMG_1.JPG"])
  }

  func testTheStemIsCaseFoldedAndTheJpegExtensionMayBeEitherSpelling() {
    let pairs = RawJpegPairing.pairs(in: ["/a/img_1.dng", "/a/IMG_1.JPEG"])

    XCTAssertEqual(pairs, ["/a/img_1.dng": "/a/IMG_1.JPEG"])
  }

  func testTheStemIsNFCNormalised() {
    let decomposed = "Cafe\u{301}.CR3"
    let composed = "Caf\u{E9}.jpg"

    XCTAssertEqual(
      RawJpegPairing.pairs(in: ["/a/\(decomposed)", "/a/\(composed)"]),
      ["/a/\(decomposed)": "/a/\(composed)"])
  }

  func testTwoJpegsOnOneStemStayIndependent() {
    XCTAssertTrue(
      RawJpegPairing.pairs(in: ["/a/IMG_1.CR3", "/a/IMG_1.jpg", "/a/IMG_1.JPEG"]).isEmpty)
  }

  func testTwoRawsOnOneStemStayIndependent() {
    XCTAssertTrue(
      RawJpegPairing.pairs(in: ["/a/IMG_1.CR3", "/a/IMG_1.DNG", "/a/IMG_1.jpg"]).isEmpty)
  }

  func testARawBesideAHeicStaysIndependent() {
    XCTAssertTrue(RawJpegPairing.pairs(in: ["/a/IMG_1.CR3", "/a/IMG_1.HEIC"]).isEmpty)
  }

  func testTheSameStemInTwoFoldersIsNotAPair() {
    XCTAssertTrue(RawJpegPairing.pairs(in: ["/a/IMG_1.CR3", "/b/IMG_1.JPG"]).isEmpty)
  }

  func testEachFolderPairsOnItsOwn() {
    let pairs = RawJpegPairing.pairs(
      in: ["/a/IMG_1.CR3", "/a/IMG_1.JPG", "/b/IMG_1.CR3", "/b/IMG_1.JPG"])

    XCTAssertEqual(pairs, ["/a/IMG_1.CR3": "/a/IMG_1.JPG", "/b/IMG_1.CR3": "/b/IMG_1.JPG"])
  }

  func testTheCompanionTakesTheRawsNewStemAndKeepsItsOwnExtension() {
    let stack = RawJpegStack(
      primary: .init(name: "IMG_1.CR3", size: 1),
      companion: .init(name: "IMG_1.JPG", size: 1),
      location: .local(URL(fileURLWithPath: "/a/IMG_1.JPG")))

    XCTAssertEqual(stack.companionFilename(forPrimaryFilename: "Trip.CR3"), "Trip.JPG")
  }

  func testInfoListsTheRawFirstAsPrimaryWithTypeAndSize() {
    let stack = RawJpegStack(
      primary: .init(name: "IMG_1.CR3", size: 1_000_000),
      companion: .init(name: "IMG_1.JPG", size: nil),
      location: .local(URL(fileURLWithPath: "/a/IMG_1.JPG")))

    XCTAssertEqual(
      stack.infoRows,
      [
        .init(
          name: "IMG_1.CR3", type: "RAW (CR3)",
          size: ByteCountFormatter.string(fromByteCount: 1_000_000, countStyle: .file),
          isPrimary: true),
        .init(name: "IMG_1.JPG", type: "JPEG", size: nil, isPrimary: false),
      ])
  }

  func testThePreferenceDefaultsOnAndReadsTheStoredValue() throws {
    let suite = "raw-jpeg-stack-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }

    XCTAssertTrue(RawJpegStackPreference.isEnabled(in: defaults))
    defaults.set(false, forKey: RawJpegStackPreference.defaultsKey)
    XCTAssertFalse(RawJpegStackPreference.isEnabled(in: defaults))
    defaults.set(true, forKey: RawJpegStackPreference.defaultsKey)
    XCTAssertTrue(RawJpegStackPreference.isEnabled(in: defaults))
  }
}
