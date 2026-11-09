import XCTest

@testable import MapleCore

/// #5132: a sidecar left in `.maple/trash` after its last same-stem photo is
/// gone is removed by the expiry sweep once it is older than the retention
/// window; one with a photo beside it is never touched. The local tests use
/// real files in a temp dir; the SMB ones the in-memory transport.
final class TrashOrphanedSidecarTests: XCTestCase {
  private var root: URL!
  private let longAgo = Date().addingTimeInterval(-40 * 86_400)

  override func setUp() {
    super.setUp()
    root = FileOperationsTestSupport.makeTempDir()
  }

  override func tearDown() {
    FileOperationsTestSupport.cleanup(root)
    root = nil
    super.tearDown()
  }

  private var trash: URL { root.appendingPathComponent(".maple/trash") }

  @discardableResult
  private func put(_ name: String, in folder: String = "2024", modified: Date? = nil) -> URL {
    let url = FileOperationsTestSupport.write(
      name, to: trash.appendingPathComponent(folder).appendingPathComponent(name))
    if let modified {
      try! FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: url.path)
    }
    return url
  }

  private func sweep() -> Int {
    LocalFileOperations.sweepExpiredMapleTrash(libraryRoot: root, olderThanDays: 30)
  }

  // MARK: - Local

  func testASidecarOutlivingItsLastPhotoIsRemoved() throws {
    let raw = put("IMG_1.CR3", modified: longAgo)
    let jpeg = put("IMG_1.JPG", modified: longAgo)
    let sidecar = put("IMG_1.xmp", modified: longAgo)
    LocalFileOperations.writeTrashedMarker(forItemAt: raw, date: Date())
    LocalFileOperations.writeTrashedMarker(forItemAt: jpeg, date: Date())
    let items = LocalFileOperations.listMapleTrash(libraryRoot: root)
    let rawItem = try XCTUnwrap(items.first { $0.displayName == "IMG_1.CR3" })

    try LocalFileOperations.permanentlyDeleteFromMapleTrash(rawItem, libraryRoot: root)
    XCTAssertTrue(
      FileOperationsTestSupport.exists(sidecar), "the JPEG still claims the sidecar")
    try FileManager.default.removeItem(at: jpeg)
    LocalFileOperations.removeTrashedMarker(forItemAt: jpeg)

    XCTAssertEqual(sweep(), 1)
    XCTAssertFalse(FileOperationsTestSupport.exists(sidecar))
  }

  func testASidecarWithAPhotoBesideItIsNeverTouched() {
    let raw = put("IMG_1.CR3", modified: longAgo)
    let sidecar = put("IMG_1.xmp", modified: longAgo)
    LocalFileOperations.writeTrashedMarker(forItemAt: raw, date: Date())

    XCTAssertEqual(sweep(), 0)
    XCTAssertTrue(FileOperationsTestSupport.exists(sidecar))
    XCTAssertTrue(FileOperationsTestSupport.exists(raw))
  }

  func testAnOrphanedSidecarInsideTheRetentionWindowStays() {
    let sidecar = put("IMG_1.xmp", modified: Date().addingTimeInterval(-10 * 86_400))

    XCTAssertEqual(sweep(), 0)
    XCTAssertTrue(FileOperationsTestSupport.exists(sidecar))
  }

  func testWorkflowVariantsAndForeignBranchesStayWithTheirPhoto() {
    let raw = put("IMG_1.CR3", modified: longAgo)
    LocalFileOperations.writeTrashedMarker(forItemAt: raw, date: Date())
    let variant = put("IMG_1.v\(UUID().uuidString.lowercased()).xmp", modified: longAgo)
    let foreign = put("IMG_1.v2.xmp", modified: longAgo)
    let strayVariant = put("IMG_2.v\(UUID().uuidString.lowercased()).xmp", modified: longAgo)

    XCTAssertEqual(sweep(), 1)
    XCTAssertTrue(FileOperationsTestSupport.exists(variant))
    XCTAssertTrue(FileOperationsTestSupport.exists(foreign))
    XCTAssertFalse(FileOperationsTestSupport.exists(strayVariant))
  }

  func testAVideosSidecarIsClaimedByTheFullNameOnly() {
    let video = put("clip.mov", modified: longAgo)
    LocalFileOperations.writeTrashedMarker(forItemAt: video, date: Date())
    let own = put("clip.mov.xmp", modified: longAgo)
    let imageStem = put("clip.xmp", modified: longAgo)

    XCTAssertEqual(sweep(), 1)
    XCTAssertTrue(FileOperationsTestSupport.exists(own))
    XCTAssertFalse(FileOperationsTestSupport.exists(imageStem))
  }

  func testOnlyOrphanedSidecarsAreRemovedFromANestedTrashTree() {
    let orphan = put("IMG_9.xmp", in: "2023/Rome", modified: longAgo)
    let note = put("notes.txt", in: "2023/Rome", modified: longAgo)
    let kept = put("IMG_1.xmp", in: "2024/Paris", modified: longAgo)
    put("IMG_1.dng", in: "2024/Paris", modified: longAgo)
    let atRoot = FileOperationsTestSupport.write(
      "<xmp/>", to: trash.appendingPathComponent("LOOSE.xmp"))
    try! FileManager.default.setAttributes(
      [.modificationDate: longAgo], ofItemAtPath: atRoot.path)

    XCTAssertEqual(sweep(), 2)
    XCTAssertFalse(FileOperationsTestSupport.exists(orphan))
    XCTAssertFalse(FileOperationsTestSupport.exists(atRoot))
    XCTAssertTrue(FileOperationsTestSupport.exists(note))
    XCTAssertTrue(FileOperationsTestSupport.exists(kept))
  }

  // MARK: - SMB

  private let smbTrash = "/.maple/trash/2024"

  func testSMBSidecarLeftByTheCaseFoldingStemRuleIsRemoved() async throws {
    let t = FakeSMBTransport()
    for name in ["IMG_1.CR3", "IMG_1.xmp", "img_1.JPG", "img_1.xmp"] {
      await t.seed(name, at: "\(smbTrash)/\(name)", mtime: longAgo)
    }
    for primary in ["IMG_1.CR3", "img_1.JPG"] {
      await SMBFileOperations.writeTrashedMarker(
        forItemAt: "\(smbTrash)/\(primary)", date: longAgo, transport: t)
    }
    let items = await SMBFileOperations.listMapleTrash(transport: t)
    let raw = try XCTUnwrap(items.first { $0.displayName == "IMG_1.CR3" })
    let jpeg = try XCTUnwrap(items.first { $0.displayName == "img_1.JPG" })

    try await SMBFileOperations.permanentlyDeleteFromMapleTrash(raw, transport: t)
    let keptForJpeg = await t.fileExists(at: "\(smbTrash)/IMG_1.xmp")
    XCTAssertTrue(keptForJpeg, "the JPEG still claims the sidecar")
    try await SMBFileOperations.permanentlyDeleteFromMapleTrash(jpeg, transport: t)
    let orphanBeforeSweep = await t.fileExists(at: "\(smbTrash)/IMG_1.xmp")
    XCTAssertTrue(orphanBeforeSweep, "no purge ever visits the sidecar")

    let swept = await SMBFileOperations.sweepExpiredMapleTrash(olderThanDays: 30, transport: t)

    XCTAssertEqual(swept, 1)
    let remaining = await t.fileExists(at: "\(smbTrash)/IMG_1.xmp")
    XCTAssertFalse(remaining)
  }

  func testSMBSidecarWithAPhotoBesideItIsNeverTouched() async throws {
    let t = FakeSMBTransport()
    await t.seed("pixels", at: "\(smbTrash)/IMG_1.CR3", mtime: longAgo)
    await t.seed("<xmp/>", at: "\(smbTrash)/IMG_1.xmp", mtime: longAgo)
    await t.seed("<xmp/>", at: "\(smbTrash)/IMG_2.xmp", mtime: Date())
    await SMBFileOperations.writeTrashedMarker(
      forItemAt: "\(smbTrash)/IMG_1.CR3", date: Date(), transport: t)

    let swept = await SMBFileOperations.sweepExpiredMapleTrash(olderThanDays: 30, transport: t)

    XCTAssertEqual(swept, 0)
    let sidecar = await t.fileExists(at: "\(smbTrash)/IMG_1.xmp")
    let recentOrphan = await t.fileExists(at: "\(smbTrash)/IMG_2.xmp")
    XCTAssertTrue(sidecar)
    XCTAssertTrue(recentOrphan, "an orphan inside the retention window stays")
  }
}
