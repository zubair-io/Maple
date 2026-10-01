import Foundation

enum XMPMaskGroupNamespaces {
  static let owned = [
    "crs": "http://ns.adobe.com/camera-raw-settings/1.0/",
    "papp": "http://ns.justmaple.app/photo/1.0/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  ]

  static func canonical(_ name: String, namespaces: [String: String]) -> String? {
    let parts = name.split(separator: ":", maxSplits: 1).map(String.init)
    guard parts.count == 2, let uri = namespaces[parts[0]],
      let prefix = owned.first(where: { $0.value == uri })?.key
    else { return nil }
    return prefix + ":" + parts[1]
  }

  static func attributes(_ source: [String: String], namespaces: [String: String]) -> [String:
    String]
  {
    source.reduce(into: [:]) { result, entry in
      if let name = canonical(entry.key, namespaces: namespaces) { result[name] = entry.value }
    }
  }

  static func matches(_ name: String, _ expected: String, namespaces: [String: String]) -> Bool {
    canonical(name, namespaces: namespaces) == expected
  }

  /// Foreign attributes cannot rebind a prefix used by the generated geometry.
  /// Reserve every imported prefix before selecting a replacement alias.
  static func metadata(
    _ attributes: [String: String], owned keys: Set<String>, nodes: [String],
    namespaces: [String: String]
  ) -> LocalXmpMetadata? {
    var reserved = Set(namespaces.keys)
    var aliases: [String: String] = [:]
    let extras = attributes.sorted { $0.key < $1.key }.compactMap {
      name, value -> LocalXmpMetadata.Attribute? in
      guard name != "xmlns", !name.hasPrefix("xmlns:") else { return nil }
      if let canonical = canonical(name, namespaces: namespaces) {
        return keys.contains(canonical) ? nil : .init(name: canonical, value: value)
      }
      let parts = name.split(separator: ":", maxSplits: 1).map(String.init)
      guard parts.count == 2, let uri = namespaces[parts[0]], parts[0] != "xml" else {
        return .init(name: name, value: value)
      }
      let prefix: String
      if Self.owned[parts[0]] != nil {
        if let alias = aliases[uri] {
          prefix = alias
        } else {
          var index = 0
          while reserved.contains(index == 0 ? "maskmeta" : "maskmeta\(index)") { index += 1 }
          prefix = index == 0 ? "maskmeta" : "maskmeta\(index)"
          reserved.insert(prefix)
          aliases[uri] = prefix
        }
      } else {
        prefix = parts[0]
      }
      return .init(name: prefix + ":" + parts[1], value: value, namespace: uri)
    }
    return extras.isEmpty && nodes.isEmpty
      ? nil : LocalXmpMetadata(attributes: extras.sorted { $0.name < $1.name }, nodes: nodes)
  }
}
