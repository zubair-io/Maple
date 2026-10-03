import Darwin
import Foundation

public enum AgentSocketError: Error, Equatable, CustomStringConvertible {
  case pathTooLong(String)
  case addressInUse(String)
  case system(call: String, errno: Int32)
  case connectionClosed
  case malformedResponse

  public var description: String {
    switch self {
    case .pathTooLong(let path): return "Socket path exceeds the sun_path limit: \(path)"
    case .addressInUse(let path): return "Another process is already serving \(path)"
    case .system(let call, let code): return "\(call) failed: \(String(cString: strerror(code)))"
    case .connectionClosed: return "The connection closed before a response arrived"
    case .malformedResponse: return "The response was not a valid agent message"
    }
  }
}

/// Where the app listens. The app-group container is the one directory the
/// sandboxed app may bind in that an unsandboxed bridge can also reach; it is
/// already private to the user (0700), and the socket itself is 0600.
public enum AgentSocketLocation {
  public static let appGroup = "group.app.justmaple.aperture"
  public static let fileName = "maple-agent.sock"

  public static func path(inGroupContainer container: URL) -> String {
    container.appendingPathComponent(fileName).path
  }

  /// The bridge runs outside the sandbox, so it derives the container from
  /// the account's home directory rather than `containerURL(forSecurity…)`.
  public static func defaultPath() -> String {
    let home =
      getpwuid(getuid()).flatMap { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
    return URL(fileURLWithPath: home)
      .appendingPathComponent("Library/Group Containers/\(appGroup)/\(fileName)").path
  }
}

enum UnixSocket {
  static func makeAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    let bytes = Array(path.utf8)
    guard bytes.count < capacity else { throw AgentSocketError.pathTooLong(path) }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
      buffer.copyBytes(from: bytes)
      buffer[bytes.count] = 0
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
  }

  static func makeSocket() throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw AgentSocketError.system(call: "socket", errno: errno) }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    return fd
  }

  static func connect(_ path: String) throws -> Int32 {
    var address = try makeAddress(path)
    let fd = try makeSocket()
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard result == 0 else {
      let code = errno
      close(fd)
      throw AgentSocketError.system(call: "connect", errno: code)
    }
    return fd
  }

  static func setReceiveTimeout(_ fd: Int32, seconds: TimeInterval) {
    var timeout = timeval(
      tv_sec: Int(seconds), tv_usec: Int32((seconds - seconds.rounded(.down)) * 1_000_000))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  }

  static func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { buffer in
      guard let base = buffer.baseAddress else { return }
      var offset = 0
      while offset < buffer.count {
        let written = write(fd, base + offset, buffer.count - offset)
        if written < 0 {
          if errno == EINTR { continue }
          throw AgentSocketError.system(call: "write", errno: errno)
        }
        offset += written
      }
    }
  }

  static func writeLine(_ fd: Int32, _ value: JSONValue) throws {
    var data = try value.encodedLine()
    data.append(0x0A)
    try writeAll(fd, data)
  }
}

/// Splits a byte stream into newline-terminated messages.
struct LineReader {
  private let fd: Int32
  private var buffer = Data()

  init(fd: Int32) { self.fd = fd }

  /// The next line without its terminator, or nil at end of stream.
  mutating func nextLine() throws -> Data? {
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
      if let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer[buffer.startIndex..<newline]
        buffer.removeSubrange(buffer.startIndex...newline)
        return Data(line)
      }
      let count = read(fd, &chunk, chunk.count)
      if count < 0 {
        if errno == EINTR { continue }
        throw AgentSocketError.system(call: "read", errno: errno)
      }
      if count == 0 { return nil }
      buffer.append(contentsOf: chunk[0..<count])
    }
  }
}
