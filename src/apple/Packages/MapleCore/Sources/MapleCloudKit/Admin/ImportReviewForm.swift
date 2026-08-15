// ImportReviewForm.swift — editable per-bucket label state for the
// Imports wizard's step 2 review (#2773).
//
// A bucket's label starts BLANK, not pre-filled with its month: leaving it
// blank means "use the server's default" (an already-indexed nearby photo
// first, then `<year>/misc/<source folder>` — see `imports/scan.ts`'s
// `buildImportFiles` precedence comment). This file owns the two rules that
// keep that contract intact on the client:
//
//   1. A blank label must never reach the create request — even
//      `{key: ""}` would arrive as a real (if degenerate) override rather
//      than "no override." `requestLabels()` drops blank entries entirely.
//   2. Whether a bucket counts as "overridden" (which is what hides the
//      nearby-match note) is judged the SAME way the server judges
//      precedence — a non-blank, trimmed label — so the UI's opinion can
//      never disagree with what the create request is about to do.

import Foundation

public struct ImportReviewForm: Equatable, Sendable {
  public var labels: [String: String]

  public init(labels: [String: String] = [:]) {
    self.labels = labels
  }

  public func label(for bucketKey: String) -> String {
    labels[bucketKey] ?? ""
  }

  public mutating func setLabel(_ value: String, for bucketKey: String) {
    labels[bucketKey] = value
  }

  /// True once the user has typed a real override for this bucket. An
  /// override always wins over a nearby-asset match server-side, so this
  /// is also what gates the nearby-match note's visibility.
  public func hasOverride(for bucket: ImportScanBucket) -> Bool {
    !trimmed(labels[bucket.key]).isEmpty
  }

  /// The destination a bucket's files will actually land in, reflecting the
  /// current (possibly still-being-typed) override — so the review screen
  /// never shows a stale or ambiguous folder.
  public func effectiveDest(for bucket: ImportScanBucket) -> String {
    let override = trimmed(labels[bucket.key])
    return override.isEmpty ? bucket.defaultDest : "\(bucket.year)/\(override)"
  }

  /// Build the create request's `labels` field. Blank (or whitespace-only)
  /// entries are omitted rather than sent as `""` — a present-but-empty
  /// label is not "no override" once it reaches the server's precedence
  /// chain, it's an override to an empty segment. `nil` when nothing is
  /// overridden, matching the API's optional field.
  public func requestLabels() -> [String: String]? {
    let overrides = labels.compactMapValues { value -> String? in
      let value = trimmed(value)
      return value.isEmpty ? nil : value
    }
    return overrides.isEmpty ? nil : overrides
  }

  private func trimmed(_ value: String?) -> String {
    (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
