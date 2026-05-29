// BottomSheet.swift — phone Info modal primitive (S1c, #599).
//
// Spec: docs/spec/responsive-program-s1-phone-shell.md §4.1.
//
// Thin `View` extension wrapping `.sheet(.presentationDetents(...))` so
// S4 Loupe, S5 Editor, and S6 phone Detail share one modal contract:
//   `.mapleBottomSheet(isPresented: $isInfoOpen) { InfoSheetContent() }`
//
// Native deviations from the design spec (accepted for v1):
//   • Scrim ~50% (system) vs spec 35%.
//   • Grab handle is the system indicator vs spec 38×4pt at `--color-border-hi`.
//   • Native dismiss threshold (~50% sheet height) vs spec 25% OR
//     1000 px/s flick.
//
// All three are out of reach for the public SwiftUI presentation API
// surface. The Web takes a hand-rolled path with full spec compliance
// (src/web/projects/maple-common/src/lib/shells/bottom-sheet.component.*).
// If design review pushes back, a hand-rolled iOS sheet (~150 LOC) is
// the follow-up; until then native is the right tradeoff.

#if os(iOS)
import SwiftUI

extension View {
    /// Phone Info bottom sheet — 74% viewport height, 18pt top corners,
    /// system grab handle, native gesture dismiss.
    ///
    /// - Parameters:
    ///   - isPresented: Binding driving sheet visibility.
    ///   - content: The sheet body. Pad / style at the call site.
    func mapleBottomSheet<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        self.sheet(isPresented: isPresented) {
            content()
                .presentationDetents([.fraction(0.74)])
                .presentationDragIndicator(.visible)
                .presentationBackground(MapleTokens.surface)
                .presentationCornerRadius(18)
        }
    }
}

// MARK: - Previews

#Preview("Bottom sheet — open with sample content") {
    @Previewable @State var isOpen = true
    return Color.black
        .ignoresSafeArea()
        .overlay {
            Button("Open sheet") { isOpen = true }
                .foregroundStyle(.white)
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
#endif
