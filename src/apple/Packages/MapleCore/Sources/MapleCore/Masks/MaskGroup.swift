import Foundation

/// Unknown XML travels with a correction/component; the Rust renderer never
/// interprets it. Keeping it here preserves metadata through undo and removal.
public struct LocalXmpMetadata: Codable, Sendable, Equatable, Hashable {
  public struct Attribute: Codable, Sendable, Equatable, Hashable {
    public var name: String
    public var value: String
    public var namespace: String?
    public init(name: String, value: String, namespace: String? = nil) {
      self.name = name
      self.value = value
      self.namespace = namespace
    }
  }
  public var attributes: [Attribute]
  public var nodes: [String]
  public init(attributes: [Attribute] = [], nodes: [String] = []) {
    self.attributes = attributes
    self.nodes = nodes
  }
}

/// An ordered leaf: combine/invert belong here, develop controls to its layer.
/// The constructor and decoder reject nested groups, matching raw-core.
public struct MaskComponent: Codable, Sendable, Equatable, Hashable {
  public private(set) var mask: LocalMask
  public var combine: MaskCombine
  public var invert: Bool
  public var xmpMetadata: LocalXmpMetadata?

  public init?(
    mask: LocalMask, combine: MaskCombine = .add, invert: Bool = false,
    xmpMetadata: LocalXmpMetadata? = nil
  ) {
    if case .group = mask { return nil }
    self.mask = mask
    self.combine = combine
    self.invert = invert
    self.xmpMetadata = xmpMetadata
  }

  @discardableResult
  public mutating func replaceMask(_ mask: LocalMask) -> Bool {
    if case .group = mask { return false }
    self.mask = mask
    return true
  }

  private enum CodingKeys: String, CodingKey { case mask, combine, invert, xmpMetadata }
  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let mask = try values.decode(LocalMask.self, forKey: .mask)
    guard
      let component = MaskComponent(
        mask: mask,
        combine: try values.decode(MaskCombine.self, forKey: .combine),
        invert: try values.decode(Bool.self, forKey: .invert),
        xmpMetadata: try values.decodeIfPresent(LocalXmpMetadata.self, forKey: .xmpMetadata))
    else {
      throw DecodingError.dataCorruptedError(
        forKey: .mask, in: values,
        debugDescription: "Mask components cannot contain groups")
    }
    self = component
  }
}

public struct MaskGroup: Codable, Sendable, Equatable, Hashable {
  public var components: [MaskComponent]
  public var opacity: Double
  public var invert: Bool
  public init(components: [MaskComponent], opacity: Double = 1, invert: Bool = false) {
    self.components = components
    self.opacity = opacity
    self.invert = invert
  }
}

extension MaskCombine {
  /// Alpha union, subtraction and intersection; agrees with CPU and WGSL.
  public func apply(_ accumulated: Double, _ component: Double) -> Double {
    switch self {
    case .add: return accumulated + (1 - accumulated) * component
    case .subtract: return accumulated * (1 - component)
    case .intersect: return accumulated * component
    }
  }
}

extension LocalMask {
  /// Visit all leaves once, retaining group order and metadata. A transform
  /// cannot introduce a nested group: rejection keeps the complete input.
  public func mappingLeaves(_ transform: (LocalMask) -> LocalMask) -> LocalMask {
    guard case .group(var group) = self else { return transform(self) }
    var components = group.components
    for index in components.indices {
      guard components[index].replaceMask(transform(components[index].mask)) else { return self }
    }
    group.components = components
    return .group(group)
  }

  public var bitmapMasks: [(recipe: BitmapRecipe, rasterId: UInt32)] {
    switch self {
    case .bitmap(let recipe, let rasterId): return [(recipe, rasterId)]
    case .group(let group): return group.components.flatMap { $0.mask.bitmapMasks }
    case .linear, .radial, .everywhere: return []
    }
  }

  public func mappingLeavesAsync(_ transform: (LocalMask) async -> LocalMask) async -> LocalMask {
    guard case .group(var group) = self else { return await transform(self) }
    var components = group.components
    for index in components.indices {
      let transformed = await transform(components[index].mask)
      guard components[index].replaceMask(transformed) else { return self }
    }
    group.components = components
    return .group(group)
  }
}
