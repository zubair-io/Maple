// MuiEnrichmentPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). AI-derived fields with live
// status, built from Description Field, Faces Row, Place Row, Transcript
// Block, Vision Row, Badge. No top-level loading/empty state of its own —
// each field molecule already degrades to its own placeholder/empty
// appearance given empty inputs, so this panel just wires status through
// to a small badge next to the description.

import SwiftUI

public enum MuiEnrichmentDescriptionStatus: Sendable {
    case idle, generating, done, error
}

public struct MuiEnrichmentPanel: View {
    @Binding public var description: String
    public let descriptionStatus: MuiEnrichmentDescriptionStatus
    public let people: [MuiChip]
    public let peopleRedetecting: Bool
    @Binding public var place: String
    public let placeOverridden: Bool
    public let transcriptBase: Date?
    public let transcriptEntries: [MuiTranscriptEntry]
    public let visionLabels: [MuiChip]
    @Binding public var selectedPersonId: String?
    public let descriptionRegenerate: (() -> Void)?
    public let descriptionCommitted: ((String) -> Void)?
    public let peopleRedetect: (() -> Void)?
    public let placeCommitted: ((String) -> Void)?
    public let placeCleared: (() -> Void)?

    public init(
        description: Binding<String>,
        descriptionStatus: MuiEnrichmentDescriptionStatus = .idle,
        people: [MuiChip],
        peopleRedetecting: Bool = false,
        place: Binding<String>,
        placeOverridden: Bool = false,
        transcriptBase: Date? = nil,
        transcriptEntries: [MuiTranscriptEntry] = [],
        visionLabels: [MuiChip],
        selectedPersonId: Binding<String?> = .constant(nil),
        descriptionRegenerate: (() -> Void)? = nil,
        descriptionCommitted: ((String) -> Void)? = nil,
        peopleRedetect: (() -> Void)? = nil,
        placeCommitted: ((String) -> Void)? = nil,
        placeCleared: (() -> Void)? = nil
    ) {
        self._description = description
        self.descriptionStatus = descriptionStatus
        self.people = people
        self.peopleRedetecting = peopleRedetecting
        self._place = place
        self.placeOverridden = placeOverridden
        self.transcriptBase = transcriptBase
        self.transcriptEntries = transcriptEntries
        self.visionLabels = visionLabels
        self._selectedPersonId = selectedPersonId
        self.descriptionRegenerate = descriptionRegenerate
        self.descriptionCommitted = descriptionCommitted
        self.peopleRedetect = peopleRedetect
        self.placeCommitted = placeCommitted
        self.placeCleared = placeCleared
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    HStack {
                        MuiText("Description", variant: .eyebrow, color: .muted)
                        if let label = Self.statusLabel(descriptionStatus) {
                            MuiBadge(variant: .signal, value: label)
                        }
                    }
                    MuiDescriptionField(value: $description, regenerating: descriptionStatus == .generating, regenerate: descriptionRegenerate, committed: descriptionCommitted)
                }

                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    MuiText("People", variant: .eyebrow, color: .muted)
                    MuiFacesRow(people: people, selectedId: $selectedPersonId, redetecting: peopleRedetecting, redetect: peopleRedetect)
                }

                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    MuiText("Place", variant: .eyebrow, color: .muted)
                    MuiPlaceRow(place: $place, overridden: placeOverridden, committed: placeCommitted, cleared: placeCleared)
                }

                if let transcriptBase, !transcriptEntries.isEmpty {
                    VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                        MuiText("Transcript", variant: .eyebrow, color: .muted)
                        MuiTranscriptBlock(baseTime: transcriptBase, entries: transcriptEntries)
                    }
                }

                VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                    MuiText("Detected", variant: .eyebrow, color: .muted)
                    MuiVisionRow(labels: visionLabels)
                }
            }
            .padding(MuiTokens.spacingMd)
        }
    }

    // MARK: - Pure logic (unit-testable without a live view)

    /// The status badge label for the description field — `nil` (no
    /// badge) while idle, matching the web reference's `STATUS_LABEL` map.
    public static func statusLabel(_ status: MuiEnrichmentDescriptionStatus) -> String? {
        switch status {
        case .idle: return nil
        case .generating: return "Generating…"
        case .done: return "Done"
        case .error: return "Error"
        }
    }
}

#Preview("MuiEnrichmentPanel") {
    struct Demo: View {
        @State private var description = "A lone hiker crosses a black-sand beach at dusk."
        @State private var place = "Reynisfjara, Iceland"
        @State private var selectedPerson: String? = nil
        var body: some View {
            MuiEnrichmentPanel(
                description: $description,
                descriptionStatus: .done,
                people: [MuiChip(id: "1", label: "Alex")],
                place: $place,
                placeOverridden: true,
                transcriptBase: Date(),
                transcriptEntries: [MuiTranscriptEntry(id: "1", offsetMs: 0, speaker: "Alex", text: "Watch your footing here.")],
                visionLabels: [MuiChip(id: "1", label: "Beach"), MuiChip(id: "2", label: "Person")],
                selectedPersonId: $selectedPerson
            )
            .frame(width: 300, height: 520)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
