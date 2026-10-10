import Foundation

/// The URL grant remains balanced even when a window releases its editor
/// without an explicit close. The immutable lease may cross actor lifetimes.
final class RemovalSecurityScope: Sendable {
  let url: URL
  let accessing: Bool
  init(_ url: URL) {
    self.url = url
    accessing = url.startAccessingSecurityScopedResource()
  }
  deinit { if accessing { url.stopAccessingSecurityScopedResource() } }
}
