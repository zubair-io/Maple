#if os(iOS)

import SwiftUI

/// Restores edge-swipe back navigation for destinations whose
/// custom floating header requires the system navigation bar to be hidden.
/// The edge-only start guard keeps this distinct from Preview's carousel and
/// the Editor's canvas/tool gestures.
private struct StackBackSwipeModifier: ViewModifier {
    let onBack: () -> Void

    func body(content: Content) -> some View {
        content.simultaneousGesture(
            DragGesture(minimumDistance: 10)
                .onEnded { value in
                    guard value.startLocation.x <= 24,
                          value.translation.width >= 60,
                          value.translation.width > abs(value.translation.height) * 1.5
                    else { return }
                    onBack()
                }
        )
    }
}

extension View {
    func stackBackSwipe(onBack: @escaping () -> Void) -> some View {
        modifier(StackBackSwipeModifier(onBack: onBack))
    }
}

#endif
