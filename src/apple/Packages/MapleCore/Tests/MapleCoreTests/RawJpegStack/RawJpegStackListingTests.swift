import XCTest

@testable import MapleCore

/// #5050: a local folder and a listing of SMB refs fold each RAW+JPEG pair into one tile.
@MainActor
final class RawJpegStackListingTests: XCTestCase {
  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("raw-jpeg-listing-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: folder)
  }

  private func write(_ name: String, bytes: Int) throws {
    try Data(repeating: 0x41, count: bytes).write(to: folder.appendingPathComponent(name))
  }

  private func listed(stacking: Bool = true) async -> BrowseViewModel {
    let browse = BrowseViewModel()
    browse.stacksRawJpegPairs = { stacking }
    await browse.loadFolder(url: folder)
    return browse
  }

  func testAPairIsOneTileCarryingTheJpegAsItsCompanion() async throws {
    try write("IMG_1.CR3", bytes: 300)
    try write("IMG_1.JPG", bytes: 120)
    try write("IMG_2.CR3", bytes: 50)

    let browse = await listed()

    XCTAssertEqual(browse.assets.map(\.fullFilename), ["IMG_1.CR3", "IMG_2.CR3"])
    let stack = try XCTUnwrap(browse.assets.first?.stack)
    XCTAssertEqual(stack.primary, .init(name: "IMG_1.CR3", size: 300))
    XCTAssertEqual(stack.companion, .init(name: "IMG_1.JPG", size: 120))
    XCTAssertEqual(stack.localCompanionURL?.lastPathComponent, "IMG_1.JPG")
    XCTAssertNil(browse.assets.last?.stack)
  }

  func testWithTheSettingOffBothFilesAreSeparateTiles() async throws {
    try write("IMG_1.CR3", bytes: 300)
    try write("IMG_1.JPG", bytes: 120)

    let browse = await listed(stacking: false)

    XCTAssertEqual(browse.assets.map(\.fullFilename), ["IMG_1.CR3", "IMG_1.JPG"])
    XCTAssertTrue(browse.assets.allSatisfy { $0.stack == nil })
  }

  func testAmbiguousGroupsStayIndependent() async throws {
    try write("IMG_1.CR3", bytes: 10)
    try write("IMG_1.jpg", bytes: 10)
    try write("IMG_1.jpeg", bytes: 10)
    try write("IMG_2.CR3", bytes: 10)
    try write("IMG_2.HEIC", bytes: 10)

    let browse = await listed()

    XCTAssertEqual(browse.assets.count, 5)
    XCTAssertTrue(browse.assets.allSatisfy { $0.stack == nil })
  }

  func testReloadingAfterTheSettingChangesFoldsAndSplitsThePair() async throws {
    try write("IMG_1.CR3", bytes: 300)
    try write("IMG_1.JPG", bytes: 120)
    var stacking = true
    let browse = BrowseViewModel()
    browse.stacksRawJpegPairs = { stacking }

    await browse.loadFolder(url: folder)
    XCTAssertEqual(browse.assets.count, 1)

    stacking = false
    await browse.retryLastLoad()
    XCTAssertEqual(browse.assets.count, 2)

    stacking = true
    await browse.retryLastLoad()
    XCTAssertEqual(browse.assets.count, 1)
  }

  func testSMBFoldKeepsTheRawAndCarriesTheJpegWithItsSize() throws {
    let share = UUID()
    func ref(_ path: String) -> ImageRef {
      ImageRef(
        id: "id-\(path)", displayName: (path as NSString).lastPathComponent, smbPath: path,
        smbSourceID: share)
    }
    let refs = ["/Trip/IMG_1.CR3", "/Trip/IMG_1.JPG", "/Trip/IMG_2.CR3"].map(ref)
    let sizes: [String: Int64] = ["/Trip/IMG_1.CR3": 300, "/Trip/IMG_1.JPG": 120]

    let folded = RawJpegStacking.smbFold(refs, sizes: sizes, stacksPairs: true)

    XCTAssertEqual(folded.tiles.map(\.displayName), ["IMG_1.CR3", "IMG_2.CR3"])
    let stack = try XCTUnwrap(folded.stacks["/Trip/IMG_1.CR3"])
    XCTAssertEqual(stack.primary, .init(name: "IMG_1.CR3", size: 300))
    XCTAssertEqual(stack.companion, .init(name: "IMG_1.JPG", size: 120))
    XCTAssertEqual(stack.smbCompanionRef?.smbPath, "/Trip/IMG_1.JPG")
    XCTAssertNil(folded.stacks["/Trip/IMG_2.CR3"])

    let unfolded = RawJpegStacking.smbFold(refs, sizes: sizes, stacksPairs: false)
    XCTAssertEqual(unfolded.tiles.count, 3)
    XCTAssertTrue(unfolded.stacks.isEmpty)
  }
}
