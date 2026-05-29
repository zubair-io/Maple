// BottomSheet.swift — phone Info modal primitive (S1c, #599 / KTLO #602).
//
// Spec: docs/spec/responsive-program-s1-phone-shell.md §4.
//
// Hand-rolled SwiftUI sheet, not `.sheet`. Replaces the v1 thin wrapper
// (PR #601) so the iOS sheet matches the design spec exactly, on parity
// with the Web component at
// `src/web/projects/maple-common/src/lib/shells/bottom-sheet.component.*`:
//
//   • 74% viewport height (`GeometryReader` × 0.74).
//   • 18pt top corners; `MapleTokens.surface` background.
//   • Shadow `0 -8px 30px rgba(0,0,0,0.6)`.
//   • Scrim `Color.black.opacity(0.35)` (vs system ~0.50); tap dismisses.
//   • 38×4pt grab handle in `MapleTokens.borderHi`, 8pt below top edge.
//   • Drag-to-dismiss: translation ≥ 25% of sheet height OR
//     velocity ≥ 1000 px/s (vs native ~50% threshold).
//   • Asymmetric present/dismiss timing (snappy 0.32 / 0.28).
//
// API parity with PR #601's thin wrapper — call sites do NOT change:
//   `.mapleBottomSheet(isPresented: $isInfoOpen) { InfoSheetContent() }`
//
// Accessibility: scrim layer is hidden from VO; the sheet itself carries
// `.isModal` + `.contain` so a VO swipe inside the sheet does not escape
// to the host view behind the scrim.

#if os(iOS)
import SwiftUI

// MARK: - Public API

extension View {
    /// Phone Info bottom sheet — 74% viewport height, 18pt top corners,
    /// hand-rolled grab handle + scrim + drag-to-dismiss matching spec
    /// §4.1 exactly.
    ///
    /// - Parameters:
    ///   - isPresented: Binding driving sheet visibility.
    ///   - content: The sheet body. Pad / style at the call site.
    func mapleBottomSheet<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        modifier(MapleBottomSheetModifier(isPresented: isPresented, sheetContent: content))
    }
}

// MARK: - Modifier

private struct MapleBottomSheetModifier<SheetContent: View>: ViewModifier {
    @Binding var isPresented: Bool
    @ViewBuilder var sheetContent: () -> SheetContent

    // TODO(S0a): swap to MapleTokens.Motion.sheetPresent / sheetDismiss
    // once #586 lands. Spec §4.1 timing.
    private let presentAnimation: Animation = .snappy(duration: 0.32)
    private let dismissAnimation: Animation = .snappy(duration: 0.28)

    func body(content: Content) -> some View {
        content.overlay {
            // ZStack hosts the scrim + sheet above the host content.
            // `.allowsHitTesting(isPresented)` keeps host taps live while
            // the sheet is dismissed, even though the overlay still occupies
            // the layer tree.
            ZStack(alignment: .bottom) {
                if isPresented {
                    MapleBottomSheetContainer(
                        isPresented: $isPresented,
                        dismissAnimation: dismissAnimation,
                        sheetContent: sheetContent
                    )
                    // Transition lives on the conditionally-rendered view
                    // directly so the slide-in / slide-out is symmetric
                    // and reliably tied to the `if isPresented` boundary.
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .ignoresSafeArea()
            .allowsHitTesting(isPresented)
            // Asymmetric: present uses the longer animation (0.32s),
            // dismiss uses the shorter (0.28s). SwiftUI evaluates the
            // animation expression on the NEW value of `isPresented`,
            // so flipping true→false picks `dismissAnimation` and
            // false→true picks `presentAnimation`.
            .animation(isPresented ? presentAnimation : dismissAnimation,
                       value: isPresented)
        }
    }
}

// MARK: - Container

/// Visual + gesture body. Lives behind the `if isPresented` so SwiftUI
/// invokes `.transition` symmetrically on enter / leave.
private struct MapleBottomSheetContainer<SheetContent: View>: View {
    @Binding var isPresented: Bool
    let dismissAnimation: Animation
    @ViewBuilder var sheetContent: () -> SheetContent

    /// Live drag offset in points (downward only — upward drag clamps to 0).
    @State private var dragOffset: CGFloat = 0
    /// Wall-clock start of the current drag for velocity computation.
    @State private var dragStart: Date?

    /// Spec §4.1: dismiss if drag-down ≥ 25% of sheet height.
    private let dismissFraction: CGFloat = 0.25
    /// Spec §4.1: dismiss if release velocity ≥ 1000 px/s.
    private let dismissVelocity: CGFloat = 1000
    /// 18pt top corners per spec §4.1.
    private let cornerRadius: CGFloat = 18
    /// Grab-handle size per spec §4.1.
    private let handleWidth: CGFloat = 38
    private let handleHeight: CGFloat = 4
    /// Sheet occupies 74% of viewport height per spec §4.1.
    private let heightFraction: CGFloat = 0.74

    // TODO(S0a): swap to MapleTokens.borderHi once #586 lands.
    private let handleColor = Color(hex: "#5a5552")

    var body: some View {
        GeometryReader { proxy in
            let sheetHeight = proxy.size.height * heightFraction

            ZStack(alignment: .bottom) {
                // Scrim — tap anywhere outside the sheet dismisses.
                Color.black.opacity(0.35)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { dismiss() }
                    .transition(.opacity)
                    .accessibilityHidden(true)

                // Sheet.
                VStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: handleHeight / 2)
                        .fill(handleColor)
                        .frame(width: handleWidth, height: handleHeight)
                        .padding(.top, 8)
                        .padding(.bottom, 4)
                        .accessibilityHidden(true)

                    sheetContent()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(height: sheetHeight)
                .frame(maxWidth: .infinity)
                .background(MapleTokens.surface)
                .clipShape(
                    .rect(
                        topLeadingRadius: cornerRadius,
                        bottomLeadingRadius: 0,
                        bottomTrailingRadius: 0,
                        topTrailingRadius: cornerRadius
                    )
                )
                // Spec §4.1: 0 -8px 30px rgba(0,0,0,0.6).
                .shadow(color: Color.black.opacity(0.6), radius: 15, x: 0, y: -8)
                .offset(y: max(0, dragOffset))
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            if dragStart == nil { dragStart = Date() }
                            dragOffset = max(0, value.translation.height)
                        }
                        .onEnded { value in
                            handleDragEnd(translation: value.translation.height,
                                          sheetHeight: sheetHeight)
                        }
                )
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
            }
        }
    }

    private func handleDragEnd(translation: CGFloat, sheetHeight: CGFloat) {
        let start = dragStart
        dragStart = nil

        let downward = max(0, translation)
        let distanceTriggered = sheetHeight > 0 && downward >= sheetHeight * dismissFraction

        // Velocity in px/s: total drag divided by elapsed wall-clock.
        // Web ref samples a 100ms tail window; for v1 the total-drag
        // average is fine — the 1000 px/s threshold is high enough that
        // a flick still registers and a slow drag still doesn't.
        let elapsed = max(0.001, Date().timeIntervalSince(start ?? Date()))
        let velocity = downward / CGFloat(elapsed)
        let velocityTriggered = velocity >= dismissVelocity

        if distanceTriggered || velocityTriggered {
            dismiss()
        } else {
            // Spring back. Use a snappy spring so the rebound feels
            // continuous with the drag instead of a linear easing.
            withAnimation(.snappy(duration: 0.25)) {
                dragOffset = 0
            }
        }
    }

    private func dismiss() {
        withAnimation(dismissAnimation) {
            isPresented = false
        }
        // The scrim's transition handles its own fade; the sheet's
        // `.move(edge: .bottom)` carries the slide-out. dragOffset resets
        // automatically when the container is rebuilt next presentation.
    }
}

// MARK: - Previews

#Preview("Bottom sheet — open with sample content") {
    @Previewable @State var isOpen = true
    return ZStack {
        Color(hex: "#1c1917").ignoresSafeArea()
        VStack {
            Button("Open sheet") { isOpen = true }
                .foregroundStyle(.white)
                .padding()
        }
    }
    .mapleBottomSheet(isPresented: $isOpen) {
        VStack(alignment: .leading, spacing: 12) {
            Text("Info")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(MapleTokens.textMain)
            Text("Sample sheet content")
                .foregroundStyle(MapleTokens.textMuted)
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview("Bottom sheet — toggle button") {
    @Previewable @State var isOpen = false
    return ZStack {
        Color(hex: "#1c1917").ignoresSafeArea()
        Button("Toggle sheet") { isOpen.toggle() }
            .foregroundStyle(.white)
    }
    .mapleBottomSheet(isPresented: $isOpen) {
        VStack(alignment: .leading, spacing: 12) {
            Text("Toggleable")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(MapleTokens.textMain)
            Text("Drag down, tap scrim, or toggle to dismiss.")
                .foregroundStyle(MapleTokens.textMuted)
            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
