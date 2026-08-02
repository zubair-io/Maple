// RevealFolderAction.swift — environment action for "open the asset's
// containing folder in browse" (#2518).
//
// The info pane's clickable file-path row invokes this. It's delivered as an
// environment value (mirroring `cloudAssetDetailClient` / `cloudHistogramClient`)
// so leaf views need no explicit callback threading — but note SwiftUI does
// NOT propagate custom environment values across a `.sheet` / `.popover`
// boundary (see #2234), so the value must be re-injected onto the iPhone info
// sheet content, exactly as those cloud clients are.

import MapleCore
import SwiftUI

/// Reveals an asset's containing folder in the browse grid. `nil` (the
/// default) means "no shell context" — the path row renders as plain,
/// non-clickable text.
struct RevealFolderAction {
  let run: @MainActor (AssetRef) -> Void

  @MainActor func callAsFunction(_ asset: AssetRef) { run(asset) }
}

private struct RevealFolderActionKey: EnvironmentKey {
  static let defaultValue: RevealFolderAction? = nil
}

extension EnvironmentValues {
  var revealFolderAction: RevealFolderAction? {
    get { self[RevealFolderActionKey.self] }
    set { self[RevealFolderActionKey.self] = newValue }
  }
}
