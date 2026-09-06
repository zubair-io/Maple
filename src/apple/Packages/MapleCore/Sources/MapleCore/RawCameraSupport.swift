import Foundation

/// Support for the decoded file, not a guess from its EXIF display name.
public struct RawCameraSupport: Sendable, Equatable {
  public let cameraKey: String
  public let resolution: ProfileResolution

  public var tier: CameraTier {
    CameraSupportRegistry.tier(forKey: cameraKey, resolution: resolution)
  }

  public init(cameraKey: String, resolution: ProfileResolution) {
    self.cameraKey = cameraKey
    self.resolution = resolution
  }

  init?(json: String) {
    struct Payload: Decodable {
      let cameraKey: String
      let resolution: String
    }
    guard let payload = try? JSONDecoder().decode(Payload.self, from: Data(json.utf8)),
      let resolution = ProfileResolution(rawValue: payload.resolution)
    else { return nil }
    self.init(cameraKey: payload.cameraKey, resolution: resolution)
  }

  static func fromFFI(_ pointer: UnsafePointer<CChar>?) -> RawCameraSupport? {
    pointer.flatMap { RawCameraSupport(json: String(cString: $0)) }
  }
}
