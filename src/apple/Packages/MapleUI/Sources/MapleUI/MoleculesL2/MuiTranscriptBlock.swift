// MuiTranscriptBlock.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Timestamped read-only transcript, built from Text,
// Timestamp. Each entry's time code is expressed as an offset (ms) from
// `baseTime`, rendered through the real Timestamp atom (`.timeOnly`
// format) rather than a hand-rolled mm:ss formatter — a genuine
// composition, not a lookalike.

import SwiftUI

public struct MuiTranscriptEntry: Identifiable, Sendable {
    public let id: String
    /// Milliseconds from `baseTime` this line was spoken.
    public let offsetMs: Int
    public let speaker: String?
    public let text: String

    public init(id: String, offsetMs: Int, speaker: String? = nil, text: String) {
        self.id = id
        self.offsetMs = offsetMs
        self.speaker = speaker
        self.text = text
    }
}

public struct MuiTranscriptBlock: View {
    public let baseTime: Date
    public let entries: [MuiTranscriptEntry]

    public init(baseTime: Date, entries: [MuiTranscriptEntry]) {
        self.baseTime = baseTime
        self.entries = entries
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            ForEach(entries) { entry in
                HStack(alignment: .top, spacing: MuiTokens.spacingSm) {
                    MuiTimestamp(value: entryTime(entry), format: .timeOnly)
                        .frame(width: 64, alignment: .leading)

                    VStack(alignment: .leading, spacing: 2) {
                        if let speaker = entry.speaker {
                            MuiText(speaker, variant: .chipLabel, color: .muted)
                        }
                        MuiText(entry.text, variant: .body, block: true)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func entryTime(_ entry: MuiTranscriptEntry) -> Date {
        baseTime.addingTimeInterval(Double(entry.offsetMs) / 1000)
    }
}

#Preview("MuiTranscriptBlock") {
    MuiTranscriptBlock(
        baseTime: Date(),
        entries: [
            MuiTranscriptEntry(id: "1", offsetMs: 0, speaker: "Ada", text: "Let's start the walkthrough."),
            MuiTranscriptEntry(id: "2", offsetMs: 4200, speaker: "Grace", text: "Sounds good — I'll share my screen."),
            MuiTranscriptEntry(id: "3", offsetMs: 9100, text: "(inaudible)"),
        ]
    )
    .padding()
    .background(MuiTokens.bg)
}
