// MuiSettingsShellMath.swift — pure stack-decision math for
// MuiSettingsShell (Templates, unified-component-catalog.md §5). Below the
// phone-tier breakpoint, the fixed-width Section nav column stacks above
// the Pane at full width instead of sitting beside it (mirrors the iOS
// Settings app's list-then-detail pattern). Matches the web reference's
// `mui-settings-shell.component.scss` container-query breakpoint.

import Foundation

enum MuiSettingsShellMath {
    static let stackBelowWidthPx: Double = 640

    static func isStacked(hostWidth: Double) -> Bool {
        hostWidth < stackBelowWidthPx
    }
}
