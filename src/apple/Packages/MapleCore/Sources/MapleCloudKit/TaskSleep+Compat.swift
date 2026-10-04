import Foundation

extension Task where Success == Never, Failure == Never {
  /// Non-generic Duration sleep workaround for swiftlang/swift#86204.
  ///
  /// In Swift 6.3.3 release builds (-O), the generic `Task.sleep<C: Clock>(for:...)`
  /// specialization emits async context frame records with mismatched sizes across
  /// compilation boundaries. When tasks are cancelled or finish, `swift_task_dealloc`
  /// encounters out-of-order LIFO deallocations and aborts with
  /// "freed pointer was not the last allocation" (#4159).
  ///
  /// This non-generic overload takes precedence during overload resolution and
  /// delegates directly to the runtime's non-generic `Task.sleep(nanoseconds:)`.
  public static func sleep(for duration: Duration) async throws {
    try Task.checkCancellation()
    let (seconds, attoseconds) = duration.components
    guard seconds > 0 || (seconds == 0 && attoseconds > 0) else { return }
    let (multiplied, overflow) = UInt64(clamping: seconds).multipliedReportingOverflow(
      by: 1_000_000_000)
    let attoNs = UInt64(clamping: attoseconds / 1_000_000_000)
    let totalNs =
      overflow ? UInt64.max : multiplied.addingReportingOverflow(attoNs).partialValue
    try await Task.sleep(nanoseconds: totalNs)
  }
}
