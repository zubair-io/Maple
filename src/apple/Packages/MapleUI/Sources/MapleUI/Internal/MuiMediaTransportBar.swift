// MuiMediaTransportBar.swift — the play/pause + scrubber + mm:ss row
// shared by MuiVideoPlayer and MuiAudioPlayer (unified-component-catalog.md
// §2.7's "Built from: Button, Progress, Timestamp" — no dedicated glyph
// exists for play/pause in `MuiIcon`'s SF Symbol usage elsewhere in this
// wave, so this reaches for `play.fill`/`pause.fill` directly, same as the
// web reference's `⏵`/`⏸` transport button). Not part of the public API
// surface — both players compose it internally.

import SwiftUI

struct MuiMediaTransportBar: View {
    @ObservedObject var model: MuiMediaTransportModel

    var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            MuiButton(
                label: model.isPlaying ? "Pause" : "Play",
                variant: .ghost,
                size: .sm,
                leadingIcon: model.isPlaying ? "pause.fill" : "play.fill",
                iconOnly: true
            ) {
                model.togglePlay()
            }

            MuiText(model.formattedCurrentTime, variant: .valueChip, color: .muted)

            GeometryReader { geo in
                MuiProgress(shape: .bar, size: .sm, value: model.progressPercent)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { drag in
                                let ratio = geo.size.width > 0 ? Double(drag.location.x / geo.size.width) : 0
                                model.seek(toRatio: ratio)
                            }
                    )
            }
            .frame(height: 16)

            MuiText(model.formattedDuration, variant: .valueChip, color: .muted)
        }
    }
}
