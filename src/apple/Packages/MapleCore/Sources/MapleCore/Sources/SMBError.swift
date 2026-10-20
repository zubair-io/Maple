import Foundation

public enum SMBError: Error, LocalizedError {
  case invalidServerURL(String)
  case notConnected
  case writeFailedAfterRetries
  case ambiguousLocation(String)
  case foreignShare(String)

  public var errorDescription: String? {
    switch self {
    case .invalidServerURL(let h): return "Invalid SMB server URL: \(h)"
    case .notConnected: return "Not connected to SMB share"
    case .writeFailedAfterRetries: return "SMB sidecar write failed after retries"
    case .ambiguousLocation(let name):
      return "\(name) has identical copies on this share. Reopen the folder and try again."
    case .foreignShare(let name):
      return "\(name) belongs to a different share. Reopen that share and try again."
    }
  }
}
