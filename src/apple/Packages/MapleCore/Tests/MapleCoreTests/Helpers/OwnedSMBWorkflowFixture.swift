import Darwin
import Foundation
import XCTest

@testable import MapleCore

/// Real, isolated Samba transport. It never changes system Sharing or user credentials.
final class OwnedSMBWorkflowFixture {
  let directory: URL
  let share: URL
  let raw: URL
  let original: Data
  let source = SMBSource()
  let credentials: SMBSource.Credentials
  private let diagnostics: OwnedSMBDiagnostics
  private let process = Process()
  private let input = Pipe()
  private var termination: Task<Void, Never>?
  private let output: FileHandle

  private init(testCase: XCTestCase, initialXML: String?) throws {
    diagnostics = OwnedSMBDiagnostics(testCase: testCase)
    let files = try NativeWorkflowControlFixture.files()
    defer { try? FileManager.default.removeItem(at: files.directory) }
    // Samba uses UNIX-domain sockets; macOS limits their paths to 104 bytes.
    directory = URL(fileURLWithPath: "/tmp", isDirectory: true)
      .appendingPathComponent("msmb-" + UUID().uuidString.lowercased(), isDirectory: true)
    original = files.original
    share = directory.appendingPathComponent("share")
    try FileManager.default.createDirectory(at: share, withIntermediateDirectories: true)
    raw = share.appendingPathComponent("photo.dng")
    try FileManager.default.copyItem(at: files.raw, to: raw)
    if let initialXML {
      try Data(initialXML.utf8).write(to: share.appendingPathComponent("photo.xmp"))
    }
    for name in ["private", "lock", "state", "cache", "pid", "rpc", "logs"] {
      try FileManager.default.createDirectory(
        at: directory.appendingPathComponent(name), withIntermediateDirectories: true)
    }
    let port = try Self.unusedPort()
    let username = NSUserName()
    credentials = .init(
      host: "127.0.0.1:\(port)", share: "WORKFLOW", username: username,
      password: "owned-loopback-fixture")
    let passwordFile = directory.appendingPathComponent("private", isDirectory: true)
      .appendingPathComponent("smbpasswd")
    // Synthetic fixture password's NT hash. This private database is owned by this test.
    let timestamp = String(format: "%08X", UInt32(Date().timeIntervalSince1970))
    let account =
      "\(username):\(getuid()):XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX:277E43A624C2806C98EB2F7333A86714:[UX         ]:LCT-\(timestamp):\n"
    try Data(account.utf8).write(to: passwordFile)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600], ofItemAtPath: passwordFile.path)
    let config = directory.appendingPathComponent("smb.conf")
    // Homebrew Samba on macOS leaves temporary mkdir entries at mode 000.
    // Ordinary protocol mkdir succeeds with this documented VFS option; the
    // same failure was reproduced independently using Impacket, not Maple.
    let configuration = """
      [global]
      server role = standalone server
      security = user
      passdb backend = smbpasswd:\(passwordFile.path)
      interfaces = 127.0.0.1
      bind interfaces only = yes
      smb ports = \(port)
      server min protocol = SMB2
      server multi channel support = no
      private dir = \(directory.path)/private
      lock directory = \(directory.path)/lock
      state directory = \(directory.path)/state
      cache directory = \(directory.path)/cache
      pid directory = \(directory.path)/pid
      ncalrpc dir = \(directory.path)/rpc
      log file = \(directory.path)/logs/log.%m
      load printers = no
      printing = bsd
      printcap name = /dev/null
      disable spoolss = yes
      [WORKFLOW]
      path = \(share.path)
      read only = no
      guest ok = no
      vfs mkdir use tmp name = no
      """
    try Data(configuration.utf8).write(to: config)
    let log = directory.appendingPathComponent("server.log")
    _ = FileManager.default.createFile(atPath: log.path, contents: nil)
    output = try FileHandle(forWritingTo: log)
    let executable = [
      "/opt/homebrew/sbin/samba-dot-org-smbd", "/usr/local/sbin/samba-dot-org-smbd",
    ]
    .first { FileManager.default.isExecutableFile(atPath: $0) }
    guard let executable else {
      throw WorkflowSidecarError(
        message: "Install Samba with brew install samba to run real SMB regressions.")
    }
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = [
      "-F", "--no-process-group", "--debug-stdout", "-d", "10", "-s", config.path,
    ]
    process.standardOutput = output
    process.standardError = output
    // Foreground smbd exits on stdin EOF. Keep an owned pipe open until cleanup.
    process.standardInput = input
  }

  static func open(testCase: XCTestCase, initialXML: String? = NativeWorkflowControlFixture.input())
    async throws
    -> OwnedSMBWorkflowFixture
  {
    let fixture = try OwnedSMBWorkflowFixture(testCase: testCase, initialXML: initialXML)
    let exit = AsyncStream<Void>.makeStream()
    fixture.process.terminationHandler = { _ in exit.continuation.finish() }
    fixture.termination = Task { for await _ in exit.stream {} }
    do { try fixture.process.run() } catch {
      exit.continuation.finish()
      fixture.diagnostics.record(error)
      throw error
    }
    let deadline = Date().addingTimeInterval(15)
    while fixture.process.isRunning {
      do {
        try await fixture.source.connect(credentials: fixture.credentials)
        // Keep diagnostics alive until XCTest records an unexpected thrown failure.
        testCase.addTeardownBlock { await fixture.close() }
        return fixture
      } catch {
        guard Date() < deadline else {
          await fixture.close(error: error)
          throw error
        }
        try await Task.sleep(for: .milliseconds(100))
      }
    }
    let log = try String(
      contentsOf: fixture.directory.appendingPathComponent("server.log"), encoding: .utf8)
    let error = WorkflowSidecarError(
      message: "Owned Samba exited (\(fixture.process.terminationStatus)): \(log)")
    await fixture.close(error: error)
    throw error
  }

  func image() async throws -> ImageRef {
    let images = try await source.images()
    return try XCTUnwrap(images.first { $0.displayName == "photo.dng" })
  }
  func close(error: Error? = nil) async {
    if let error { diagnostics.record(error) }
    await source.disconnect()
    if process.isRunning {
      process.terminate()
    }
    await termination?.value
    try? output.close()
    if !diagnostics.preserve(directory) { try? FileManager.default.removeItem(at: directory) }
  }
  deinit {
    if process.isRunning {
      process.terminate()
    }
    try? output.close()
    if !diagnostics.preserve(directory) { try? FileManager.default.removeItem(at: directory) }
  }

  private static func unusedPort() throws -> UInt16 {
    let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard socket >= 0 else { throw POSIXError(.EIO) }
    defer { Darwin.close(socket) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard result == 0 else { throw POSIXError(.EIO) }
    var size = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(socket, $0, &size) }
    }
    guard named == 0 else { throw POSIXError(.EIO) }
    return UInt16(bigEndian: address.sin_port)
  }
}
