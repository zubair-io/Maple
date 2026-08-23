// MuiSetupWizard.swift — Maple UI Organisms · Configuration
// (unified-component-catalog.md §4.8). Multi-step guided configuration,
// built from Progress Step, Tabs, Form Field, Button.
//
// The step sequence indicator is a stack of `MuiProgressStep` rows rather
// than Tabs — Tabs implies freely jumping between panels, which doesn't fit
// a linear wizard where later steps are gated on earlier ones being valid.
// Step bodies are slotted in via a `(Int) -> Content` closure keyed on the
// active index, the SwiftUI equivalent of the web reference's projected
// `MuiWizardStepDirective` templates.

import SwiftUI

public struct MuiSetupWizard<Content: View>: View {
    public let steps: [String]
    @Binding public var stepIndex: Int
    public let canGoNext: Bool
    public let stepChanged: ((Int) -> Void)?
    public let finished: (() -> Void)?
    @ViewBuilder public let content: (Int) -> Content

    public init(
        steps: [String],
        stepIndex: Binding<Int>,
        canGoNext: Bool = true,
        stepChanged: ((Int) -> Void)? = nil,
        finished: (() -> Void)? = nil,
        @ViewBuilder content: @escaping (Int) -> Content
    ) {
        self.steps = steps
        self._stepIndex = stepIndex
        self.canGoNext = canGoNext
        self.stepChanged = stepChanged
        self.finished = finished
        self.content = content
    }

    private var isLastStep: Bool {
        stepIndex == steps.count - 1
    }

    public var body: some View {
        HStack(alignment: .top, spacing: MuiTokens.spacingLg) {
            VStack(alignment: .leading, spacing: MuiTokens.spacingLg) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, label in
                    MuiProgressStep(index: index + 1, label: label, status: Self.status(for: index, current: stepIndex))
                }
            }
            .frame(width: 160)

            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                content(stepIndex)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack {
                    if stepIndex > 0 {
                        MuiButton(label: "Back", variant: .ghost) { goBack() }
                    }
                    Spacer()
                    MuiButton(label: isLastStep ? "Finish" : "Next", variant: .primary, disabled: !canGoNext) { attemptAdvance() }
                }
            }
        }
    }

    private func goBack() {
        guard stepIndex > 0 else { return }
        stepIndex -= 1
        stepChanged?(stepIndex)
    }

    private func attemptAdvance() {
        guard canGoNext else { return }
        if isLastStep {
            finished?()
            return
        }
        stepIndex += 1
        stepChanged?(stepIndex)
    }

    /// The `MuiProgressStep` status for step `index` given the current
    /// `stepIndex` — done before it, active on it, pending after. Public +
    /// static so this is unit-testable without rendering a view.
    public static func status(for index: Int, current: Int) -> MuiProgressStepStatus {
        index < current ? .done : (index == current ? .active : .pending)
    }
}

#Preview("MuiSetupWizard") {
    struct Demo: View {
        @State private var stepIndex = 1
        var body: some View {
            MuiSetupWizard(steps: ["Server", "Storage", "Review"], stepIndex: $stepIndex) { index in
                switch index {
                case 0: MuiFormField(label: "Server host", value: .constant("maple.local"))
                case 1: MuiFormField(label: "Storage path", value: .constant("/volumes/photos"))
                default: MuiText("Ready to finish setup.", variant: .body, color: .muted)
                }
            }
            .padding()
            .frame(width: 420)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
