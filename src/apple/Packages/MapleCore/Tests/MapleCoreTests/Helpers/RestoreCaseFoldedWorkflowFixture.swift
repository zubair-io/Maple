import Foundation
import XCTest

/// Actual sidecars distinguish case-folded stems from the strict UUID grammar.
enum RestoreCaseFoldedWorkflowFixture {
  static let name = "photo.v12345678-1234-1234-1234-123456789abc.xmp"
  static let restoredName = "PHOTO.restored" + String(name.dropFirst(5))
  static let rejectedNames = [
    "photo.v1234.xmp", "photo.v12345678-1234-1234-1234-123456789ABF.xmp",
  ]
  static func stage(in directory: URL, bytes: Data) throws -> URL {
    for name in [name] + rejectedNames {
      try bytes.write(to: directory.appendingPathComponent(name))
    }
    return directory.appendingPathComponent(name)
  }
  static func assertRejectedRetained(in directory: URL, bytes: Data) throws {
    for name in rejectedNames {
      XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(name)), bytes)
    }
  }
}
