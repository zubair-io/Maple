import Foundation
import XCTest

/// Retain only this synthetic server's request/FileId/error trace after a failed test (#4110).
final class OwnedSMBDiagnostics: NSObject, XCTestObservation {
  private let owner: ObjectIdentifier
  private let lock = NSLock()
  private var failures: [String] = []

  init(testCase: XCTestCase) {
    owner = ObjectIdentifier(testCase)
    super.init()
    if Thread.isMainThread {
      XCTestObservationCenter.shared.addTestObserver(self)
    } else {
      DispatchQueue.main.sync { XCTestObservationCenter.shared.addTestObserver(self) }
    }
  }

  func testCase(
    _ testCase: XCTestCase, didFailWithDescription description: String,
    inFile filePath: String?, atLine lineNumber: Int
  ) {
    guard ObjectIdentifier(testCase) == owner else { return }
    lock.withLock {
      failures.append("\(testCase.name): \(filePath ?? "unknown"):\(lineNumber): \(description)")
    }
  }

  func record(_ error: Error) {
    lock.withLock { failures.append(String(reflecting: error)) }
  }

  @discardableResult
  func preserve(_ directory: URL) -> Bool {
    unregister()
    let messages = lock.withLock { failures }
    guard !messages.isEmpty, FileManager.default.fileExists(atPath: directory.path) else {
      return false
    }
    let root =
      ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"].map {
        URL(fileURLWithPath: $0, isDirectory: true)
      } ?? FileManager.default.temporaryDirectory
    let reports = root.appendingPathComponent("smb-diagnostics", isDirectory: true)
    let destination = reports.appendingPathComponent(directory.lastPathComponent, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: reports, withIntermediateDirectories: true)
      try Data(messages.joined(separator: "\n").utf8)
        .write(to: directory.appendingPathComponent("failures.txt"))
      try FileManager.default.moveItem(at: directory, to: destination)
      print("owned-smb-failure-diagnostics: \(destination.path)")
      return true
    } catch {
      // Preserve the original owned trace even if moving into the artifact directory fails.
      print("owned-smb-failure-diagnostics: \(directory.path); retention error: \(error)")
      return true
    }
  }

  private func unregister() {
    if Thread.isMainThread {
      XCTestObservationCenter.shared.removeTestObserver(self)
    } else {
      DispatchQueue.main.sync { XCTestObservationCenter.shared.removeTestObserver(self) }
    }
  }

  deinit { unregister() }
}
