import Foundation

enum RemovalModelTestDirectory {
  static func current(filePath: String) -> URL {
    if let path = ProcessInfo.processInfo.environment["MAPLE_REMOVAL_MODEL_ROOT"] {
      return URL(fileURLWithPath: path, isDirectory: true)
    }
    return (0..<7).reduce(URL(fileURLWithPath: filePath)) { value, _ in
      value.deletingLastPathComponent()
    }.appendingPathComponent("test-fixtures/raws/removal-inference")
  }
}
