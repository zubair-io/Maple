import Foundation

extension LocalAdjustmentXMP {
  static let groupKeys: Set<String> = [
    "papp:MaskGroupVersion", "papp:MaskGroupOpacity", "papp:MaskGroupInverted",
  ]
  static let rangeKeys: Set<String> = [
    "papp:RangeKind", "papp:RangeHue", "papp:RangeHueWidth", "papp:RangeChromaMin",
    "papp:RangeLMin", "papp:RangeLMax", "papp:RangeFeather",
  ]
  static let componentKeys: Set<String> = [
    "crs:What", "crs:MaskValue", "crs:MaskActive", "crs:MaskBlendMode", "crs:MaskInverted",
    "papp:MaskCombine", "papp:LocalFeather", "crs:ZeroX", "crs:ZeroY", "crs:FullX", "crs:FullY",
    "crs:Top", "crs:Left", "crs:Bottom", "crs:Right", "crs:Angle", "crs:Midpoint",
    "crs:Roundness", "crs:Feather", "crs:Flipped", "crs:Version", "crs:MaskSubType",
    "papp:MaskSource", "papp:MaskPerson", "papp:MaskFacialSkin", "papp:MaskBodySkin",
    "papp:MaskModel", "papp:MaskDigest",
  ]
  static var correctionKeys: Set<String> {
    groupKeys.union(rangeKeys).union(sliders.map(\.key))
      .union(["crs:What", "crs:CorrectionActive", "crs:CorrectionAmount"])
  }

  static func metadata(_ attributes: [String: String], owned: Set<String>) -> LocalXmpMetadata? {
    let extras = attributes.filter { !owned.contains($0.key) && !$0.key.hasPrefix("xmlns") }
      .sorted { $0.key < $1.key }.map { LocalXmpMetadata.Attribute(name: $0.key, value: $0.value) }
    return extras.isEmpty ? nil : LocalXmpMetadata(attributes: extras)
  }

  static func parseComponent(_ attributes: [String: String]) -> MaskComponent? {
    guard
      !["crs:MaskActive", "crs:MaskInverted", "crs:Flipped"].contains(where: {
        attributes[$0] != nil && bool(attributes[$0]) == nil
      })
    else { return nil }
    guard bool(attributes["crs:MaskActive"]) != false else { return nil }
    let numericKeys = [
      "crs:MaskBlendMode", "crs:MaskValue", "crs:Version", "crs:Angle",
      "crs:Feather", "papp:LocalFeather", "crs:Midpoint", "crs:Roundness",
    ]
    guard !numericKeys.contains(where: { attributes[$0] != nil && finite(attributes, $0) == nil })
    else { return nil }
    let kind: Kind
    switch attributes["crs:What"] {
    case maskWhat(.linear): kind = .linear
    case maskWhat(.radial): kind = .radial
    case maskWhat(.group): kind = .group
    default: return nil
    }
    let version = finite(attributes, "crs:Version") ?? 1
    guard version == 1 || version == 2 else { return nil }
    if kind == .radial,
      (finite(attributes, "crs:Midpoint") ?? 50) != 50
        || (finite(attributes, "crs:Roundness") ?? 0) != 0
    {
      return nil
    }
    guard let mask = parseMask(kind, attributes) else { return nil }
    let mode = finite(attributes, "crs:MaskBlendMode") ?? 0
    let value = finite(attributes, "crs:MaskValue") ?? 1
    let inverted = bool(attributes["crs:MaskInverted"]) ?? false
    let adobe: MaskCombine
    if mode == 0 && value == 1 {
      adobe = .add
    } else if mode == 1 && value == 0 {
      adobe = inverted ? .intersect : .subtract
    } else {
      return nil
    }
    let combine: MaskCombine
    switch attributes["papp:MaskCombine"] {
    case nil: combine = adobe
    case "Add" where mode == 0: combine = .add
    case "Subtract" where mode == 1: combine = .subtract
    case "Intersect" where mode == 1: combine = .intersect
    default: return nil
    }
    return MaskComponent(
      mask: mask, combine: combine, invert: inverted != (combine == .intersect),
      xmpMetadata: metadata(attributes, owned: componentKeys))
  }

  static func parseGroup(_ attributes: [String: String], components: [MaskComponent]) -> LocalMask?
  {
    let version = attributes["papp:MaskGroupVersion"]
    guard version == nil || version == String(LocalMaskWire.maskGroupVersion),
      !components.isEmpty,
      attributes["papp:MaskGroupOpacity"] == nil
        || finite(attributes, "papp:MaskGroupOpacity") != nil,
      attributes["papp:MaskGroupInverted"] == nil
        || bool(attributes["papp:MaskGroupInverted"]) != nil,
      attributes["crs:CorrectionActive"] == nil
        || bool(attributes["crs:CorrectionActive"]) != nil
    else { return nil }
    let opacity = finite(attributes, "papp:MaskGroupOpacity") ?? 1
    let invert = bool(attributes["papp:MaskGroupInverted"]) ?? false
    let first = components[0]
    if version == nil, components.count == 1, first.combine == .add, !first.invert,
      first.xmpMetadata == nil, opacity == 1, !invert
    {
      switch first.mask {
      case .bitmap, .everywhere: return first.mask
      default: break
      }
    }
    return .group(MaskGroup(components: components, opacity: opacity, invert: invert))
  }
}

extension XMPSerializer {
  static func _groupNumber(_ value: Double) -> String {
    let text = String(value)
    return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
  }

  static func _localMetadataAttributes(_ metadata: LocalXmpMetadata?, indent: String) -> [String] {
    guard let metadata else { return [] }
    let namespaces = Dictionary(
      metadata.attributes.compactMap { attribute -> (String, String)? in
        guard let namespace = attribute.namespace,
          let colon = attribute.name.firstIndex(of: ":"), !attribute.name.hasPrefix("xml:")
        else { return nil }
        return (String(attribute.name[..<colon]), namespace)
      }, uniquingKeysWith: { first, _ in first })
    return namespaces.sorted { $0.key < $1.key }.map {
      "\(indent)xmlns:\($0.key)=\"\(escapeXMLAttr($0.value))\""
    }
      + metadata.attributes.map { "\(indent)\($0.name)=\"\(escapeXMLAttr($0.value))\"" }
  }

  static func _localMetadataNodes(_ metadata: LocalXmpMetadata?, indent: String) -> [String] {
    metadata?.nodes.map { indent + $0 } ?? []
  }

  static func _maskGroupAttributes(_ mask: LocalMask, indent: String) -> [String] {
    guard case .group(let group) = mask else { return [] }
    return [
      "\(indent)papp:MaskGroupVersion=\"\(LocalMaskWire.maskGroupVersion)\"",
      "\(indent)papp:MaskGroupOpacity=\"\(_groupNumber(group.opacity))\"",
      "\(indent)papp:MaskGroupInverted=\"\(group.invert ? "True" : "False")\"",
    ]
  }

  static func _maskGroupLines(
    _ group: MaskGroup, indent: String,
    leafLines: (LocalMask, String, Bool) -> [String]
  ) -> [String] {
    group.components.flatMap { component -> [String] in
      let subtract = component.combine != .add
      let inverted = component.invert != (component.combine == .intersect)
      let lines = leafLines(component.mask, indent, true).map {
        $0.replacingOccurrences(
          of: "crs:MaskValue=\"1\"", with: "crs:MaskValue=\"\(subtract ? 0 : 1)\""
        )
        .replacingOccurrences(of: "/>", with: "")
      }
      let combine: String
      switch component.combine {
      case .add: combine = "Add"
      case .subtract: combine = "Subtract"
      case .intersect: combine = "Intersect"
      }
      let hasNodes = !(component.xmpMetadata?.nodes.isEmpty ?? true)
      return lines + _localMetadataAttributes(component.xmpMetadata, indent: indent + "  ") + [
        "\(indent)  papp:MaskCombine=\"\(combine)\"",
        "\(indent)  crs:MaskActive=\"True\"",
        "\(indent)  crs:MaskBlendMode=\"\(subtract ? 1 : 0)\"",
        "\(indent)  crs:MaskInverted=\"\(inverted ? "True" : "False")\"\(hasNodes ? ">" : "/>")",
      ] + _localMetadataNodes(component.xmpMetadata, indent: indent + "  ")
        + (hasNodes ? ["\(indent)</rdf:li>"] : [])
    }
  }
}
