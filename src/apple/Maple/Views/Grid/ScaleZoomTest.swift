// ScaleZoomTest.swift — on-device verification harness for ScaleZoomGrid (#1570).
//
// Renders a ScaleZoomGrid over the real library so the validated interaction
// (gestures, timing, focal tracking, crossfade settle, sync cache peek) can be
// exercised on a real device before M2 wires it into LibraryGrid permanently.
//
// Reachable via the temporary 🧪 button in LibraryGrid. DELETE at M2.

#if os(iOS)

import SwiftUI
import MapleCore

struct ScaleZoomTest: View {
    let assets: [AssetRef]
    let source: (any ImageSource)?
    let provider: ThumbnailProvider
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .top) {
            ScaleZoomGrid(
                data: assets,
                provider: provider,
                makeItem: { asset in
                    PhotoGridItem(local: asset, source: source, overlays: GridCellOverlays())
                },
                onTap: { _ in }
            )

            hud
        }
    }

    private var hud: some View {
        HStack {
            Text("\(assets.count) photos")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white)
            Spacer()
            Button("Close", action: onClose)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .background(.black.opacity(0.4))
    }
}

#endif
