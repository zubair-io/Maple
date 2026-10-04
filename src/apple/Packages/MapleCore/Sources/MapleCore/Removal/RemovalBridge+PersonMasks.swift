import Foundation
import RawPipeline

extension RemovalBridge {
  /// Cold, shared role review over exact retained MIMF masks. The metadata
  /// lengths frame one binary input; no host mask decoding or role thresholds.
  static func peopleMaskSuggestions(
    _ detections: [NativeRemovalDetection], masks: [Data], width: UInt32, height: UInt32
  ) throws -> [RemovalPersonSuggestion] {
    struct Request: Encodable {
      let schema = 1
      let sourceWidth: UInt32
      let sourceHeight: UInt32
      let detections: [NativeRemovalDetection]
      let maskLengths: [Int]
      enum CodingKeys: String, CodingKey {
        case schema, detections
        case sourceWidth = "source_width"
        case sourceHeight = "source_height"
        case maskLengths = "mask_lengths"
      }
    }
    let request = Request(
      sourceWidth: width, sourceHeight: height, detections: detections,
      maskLengths: masks.map(\.count))
    let json = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
    let input = masks.reduce(into: Data()) { $0.append($1) }
    let output = try input.withUnsafeBytes { bytes in
      try json.withCString { request in
        try buffer { output, capacity, length in
          maple_removal_people_mask_suggestions_buf(
            request, bytes.bindMemory(to: UInt8.self).baseAddress, UInt(input.count),
            output, capacity, length)
        }
      }
    }
    return try JSONDecoder().decode([RemovalPersonSuggestion].self, from: output)
  }
}

extension NativeRemovalEditorEngine {
  func peopleMaskSuggestions(
    _ people: [RemovalSession.Person], masks: [RemovalPersonSelection],
    width: UInt32, height: UInt32
  ) throws -> [RemovalSession.Person] {
    let orderedMasks = try people.map { person in
      guard let mask = masks.first(where: { $0.id == person.id }) else {
        throw RemovalError.invalid("Missing detected person mask for role review")
      }
      return mask.mask
    }
    let suggestions = try RemovalBridge.peopleMaskSuggestions(
      people.map(\.detection), masks: orderedMasks, width: width, height: height)
    guard suggestions.count == people.count else {
      throw RemovalError.invalid("Person mask review count differs")
    }
    return zip(people, suggestions).map { person, suggestion in
      RemovalSession.Person(
        id: person.id, detection: suggestion.detection, keep: suggestion.keep, role: suggestion.role
      )
    }
  }
}
