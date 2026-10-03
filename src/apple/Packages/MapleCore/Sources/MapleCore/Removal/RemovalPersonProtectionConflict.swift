import Foundation

/// Actual selected-mask overlap, not a semantic guess from detector boxes.
/// The shared mask operations still enforce protection during generation.
public struct RemovalPersonProtectionConflict: Identifiable, Sendable, Equatable {
  public let id: Int
  public let keptPersonIDs: [Int]
  public let manualProtection: Bool
  public let fullyProtected: Bool

  public var detail: String {
    let sources =
      keptPersonIDs.map { "Person \($0)" }
      + (manualProtection ? ["painted protection"] : [])
    let extent = fullyProtected ? "All selected pixels" : "Some selected pixels"
    return "\(extent) of Person \(id) are protected by \(sources.joined(separator: ", "))."
  }
}
