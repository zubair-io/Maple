import Foundation

public struct SeamConstraintsRequest: Codable, Sendable, Equatable {
  public struct Canvas: Codable, Sendable, Equatable {
    public var width: Int
    public var height: Int

    public init(width: Int, height: Int) {
      self.width = width
      self.height = height
    }
  }

  public struct Rect: Codable, Sendable, Equatable {
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
      self.x = x
      self.y = y
      self.width = width
      self.height = height
    }
  }

  public enum Kind: String, Codable, Sendable, Equatable {
    case include, exclude
  }

  public struct Region: Codable, Sendable, Equatable {
    public var frame: Int
    public var kind: Kind
    public var rect: Rect

    public init(frame: Int, kind: Kind, rect: Rect) {
      self.frame = frame
      self.kind = kind
      self.rect = rect
    }

    private enum CodingKeys: String, CodingKey {
      case frame, kind, x, y, width, height
    }

    public init(from decoder: any Decoder) throws {
      let values = try decoder.container(keyedBy: CodingKeys.self)
      frame = try values.decode(Int.self, forKey: .frame)
      kind = try values.decode(Kind.self, forKey: .kind)
      rect = Rect(
        x: try values.decode(Int.self, forKey: .x),
        y: try values.decode(Int.self, forKey: .y),
        width: try values.decode(Int.self, forKey: .width),
        height: try values.decode(Int.self, forKey: .height))
    }

    public func encode(to encoder: any Encoder) throws {
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode(frame, forKey: .frame)
      try values.encode(kind, forKey: .kind)
      try values.encode(rect.x, forKey: .x)
      try values.encode(rect.y, forKey: .y)
      try values.encode(rect.width, forKey: .width)
      try values.encode(rect.height, forKey: .height)
    }
  }

  public struct ValidationError: Error, LocalizedError, Sendable, Equatable {
    public let message: String
    public var code: String { "invalid_seam_constraints" }
    public var errorDescription: String? { "\(code): \(message)" }

    public init(_ message: String) { self.message = message }
  }

  public var version: Int
  public var canvas: Canvas
  public var regions: [Region]

  public init(
    version: Int = SeamConstraintsSchema.version, canvas: Canvas, regions: [Region]
  ) {
    self.version = version
    self.canvas = canvas
    self.regions = regions
  }

  public func validate(frameCount: Int) throws {
    guard version == SeamConstraintsSchema.version else {
      throw ValidationError("Only version \(SeamConstraintsSchema.version) is supported.")
    }
    let maximum = Int(UInt32.max)
    guard (1...maximum).contains(canvas.width), (1...maximum).contains(canvas.height) else {
      throw ValidationError("Canvas dimensions must be positive u32 integers.")
    }
    for region in regions {
      guard region.frame >= 0, region.frame < frameCount else {
        throw ValidationError("Region references an unknown frame.")
      }
      let rect = region.rect
      guard (0...maximum).contains(rect.x), (0...maximum).contains(rect.y),
        (1...maximum).contains(rect.width), (1...maximum).contains(rect.height),
        rect.x <= canvas.width, rect.y <= canvas.height,
        rect.width <= canvas.width - rect.x, rect.height <= canvas.height - rect.y
      else {
        throw ValidationError(
          "Every region must be non-empty and lie wholly inside its reference canvas.")
      }
    }
    for index in regions.indices {
      let first = regions[index]
      for other in regions[(index + 1)...] {
        let conflicts =
          first.kind == .include && other.kind == .include
          ? first.frame != other.frame
          : first.frame == other.frame && first.kind != other.kind
        guard conflicts else { continue }
        let a = first.rect
        let b = other.rect
        if a.x < b.x + b.width, b.x < a.x + a.width,
          a.y < b.y + b.height, b.y < a.y + a.height
        {
          throw ValidationError("Overlapping regions require contradictory frame ownership.")
        }
      }
    }
  }
}
