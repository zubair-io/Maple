// StageRuntimeForm.swift — editable state for a stage's runtime knobs.
//
// Free of SwiftUI so the clamping and dirty-tracking are unit-testable;
// XCUITest does not run on this machine, so anything left in a view is
// effectively unverifiable.

import Foundation

public struct StageRuntimeForm: Equatable, Sendable {
  /// Server bounds, from the PATCH route's TypeBox schema.
  public static let concurrencyRange = 1...100
  public static let maxAttemptsRange = 1...20

  public var concurrency: String
  public var maxAttempts: String

  public init(concurrency: String = "", maxAttempts: String = "") {
    self.concurrency = concurrency
    self.maxAttempts = maxAttempts
  }

  /// Seed from a stage's persisted config.
  ///
  /// A stage with no config document yet seeds blank rather than inventing
  /// defaults — showing a number the server never stored would make the
  /// fields look authoritative when nothing has been configured.
  public static func seeded(from config: StageWorkerConfig?) -> StageRuntimeForm {
    guard let config else { return StageRuntimeForm() }
    return StageRuntimeForm(
      concurrency: String(config.concurrency),
      maxAttempts: String(config.maxAttempts))
  }

  /// Parse and clamp, or nil when the field is blank or not a number.
  ///
  /// Clamping rather than rejecting matches the web: the server bounds-checks
  /// anyway, and silently correcting an out-of-range entry is friendlier
  /// than a validation error for a value the operator clearly meant as
  /// "as high as it goes".
  static func clamped(_ text: String, to range: ClosedRange<Int>) -> Int? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let value = Int(trimmed) else { return nil }
    return Swift.min(Swift.max(value, range.lowerBound), range.upperBound)
  }

  /// The patch to send, or nil when nothing usable was entered.
  ///
  /// Never carries `pollIntervalMs` or `batchSize`: those were retired as
  /// knobs in #674 and the route 400s if either key appears, so
  /// `StageRuntimePatch` has no field for them at all.
  public func patch() -> StageRuntimePatch? {
    let concurrencyValue = Self.clamped(concurrency, to: Self.concurrencyRange)
    let attemptsValue = Self.clamped(maxAttempts, to: Self.maxAttemptsRange)
    guard concurrencyValue != nil || attemptsValue != nil else { return nil }
    return StageRuntimePatch(concurrency: concurrencyValue, maxAttempts: attemptsValue)
  }

  /// Whether the form differs from what the server last reported, so Save
  /// can stay disabled until there is something to save.
  public func isDirty(comparedTo config: StageWorkerConfig?) -> Bool {
    self != Self.seeded(from: config)
  }
}
