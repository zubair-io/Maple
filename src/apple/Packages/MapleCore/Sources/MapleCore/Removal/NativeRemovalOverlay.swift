import Foundation

public struct NativeRemovalOverlay: Sendable {
  public struct Label: Sendable {
    public let id: Int
    public let x: Double
    public let y: Double
    public let keep: Bool
  }
  public let width: Int
  public let height: Int
  public let selection: Data
  public let protection: Data
  public let labels: [Label]
}

extension NativeRemovalEditorEngine {
  /// Project through the same inverse geometry used for painting: EXIF,
  /// optics, perspective, straighten and the actual preview crop rounding.
  /// This cold overlay never participates in the slider render chain.
  func overlay(
    context: NativeRemovalEditorContext, selection: Data, protection: Data,
    people: [RemovalSession.Person], cropInputSize: [UInt32], aspect: Double
  ) throws -> NativeRemovalOverlay {
    guard aspect.isFinite, aspect > 0 else { throw RemovalError.invalid("Invalid overlay aspect") }
    let width = aspect >= 1 ? 256 : max(1, Int((256 * aspect).rounded()))
    let height = aspect >= 1 ? max(1, Int((256 / aspect).rounded())) : 256
    let points: [[Double]] = (0..<height).flatMap { y -> [[Double]] in
      let normalizedY = (Double(y) + 0.5) / Double(height)
      return (0..<width).map { x -> [Double] in
        let normalizedX = (Double(x) + 0.5) / Double(width)
        return [normalizedX, normalizedY]
      }
    }
    let mapped = try map(points, context: context, cropInputSize: cropInputSize)
    guard mapped.count == points.count else { throw RemovalError.invalid("Incomplete overlay map") }
    let selected = try selection.isEmpty ? nil : RemovalBridge.decodeMask(selection)
    let protected = try protection.isEmpty ? nil : RemovalBridge.decodeMask(protection)
    var selectedRGBA = Data(repeating: 0, count: width * height * 4)
    var protectedRGBA = selectedRGBA
    var locations: [Int: [Int]] = [:]
    for (index, point) in mapped.enumerated() {
      guard let point, point.count == 2 else { continue }
      let x = point[0] * Double(context.width)
      let y = point[1] * Double(context.height)
      if Self.contains(selected, x: x, y: y) {
        selectedRGBA.replaceSubrange(index * 4..<index * 4 + 4, with: [255, 255, 255, 255])
      }
      if Self.contains(protected, x: x, y: y) {
        protectedRGBA.replaceSubrange(index * 4..<index * 4 + 4, with: [255, 255, 255, 255])
      }
      for person in people {
        let box = person.detection.bounds
        if x >= Double(box[0]), x < Double(box[2]), y >= Double(box[1]), y < Double(box[3]) {
          locations[person.id, default: []].append(index)
        }
      }
    }
    let labels = people.compactMap { person -> NativeRemovalOverlay.Label? in
      guard let indices = locations[person.id], !indices.isEmpty else { return nil }
      let x = Double(indices.reduce(0) { $0 + $1 % width }) / Double(indices.count)
      let y = Double(indices.reduce(0) { $0 + $1 / width }) / Double(indices.count)
      return NativeRemovalOverlay.Label(
        id: person.id, x: (x + 0.5) / Double(width), y: (y + 0.5) / Double(height),
        keep: person.keep)
    }
    return NativeRemovalOverlay(
      width: width, height: height, selection: selectedRGBA, protection: protectedRGBA,
      labels: labels)
  }

  private static func contains(_ mask: NativeRemovalMask?, x: Double, y: Double) -> Bool {
    guard let mask, x.isFinite, y.isFinite, x >= Double(mask.x), y >= Double(mask.y),
      x < Double(mask.x) + Double(mask.width), y < Double(mask.y) + Double(mask.height)
    else { return false }
    let index = (Int(y) - Int(mask.y)) * Int(mask.width) + Int(x) - Int(mask.x)
    return mask.pixels[index] != 0
  }
}

extension RemovalSession {
  public func overlay(cropInputSize: [UInt32], aspect: Double) async throws -> NativeRemovalOverlay
  {
    guard let context else { throw RemovalError.invalid("Removal photo is not prepared") }
    let token = revision
    let selected: Data
    let kept: Data
    if mode == .people, personChoicesNeedApply, detectedPersonMasks.count == people.count {
      let masks = try await engine.refinedPeopleSelection(
        people, masks: detectedPersonMasks, gestures: personGestures,
        manualProtection: manualProtection)
      guard current(token) else { throw CancellationError() }
      selected = masks.selection
      kept = masks.protection
    } else {
      selected = selection
      kept = protection
    }
    let result = try await engine.overlay(
      context: context, selection: selected, protection: kept, people: people,
      cropInputSize: cropInputSize, aspect: aspect)
    guard current(token) else { throw CancellationError() }
    return result
  }
}
