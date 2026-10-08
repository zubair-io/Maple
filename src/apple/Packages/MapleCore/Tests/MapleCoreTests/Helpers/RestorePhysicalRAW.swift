import Foundation

enum RestorePhysicalRAW {
  static func data() throws -> Data {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<8 { root.deleteLastPathComponent() }
    return try Data(contentsOf: root.appending(path: "test-fixtures/raws/test_0017.dng"))
  }
}
