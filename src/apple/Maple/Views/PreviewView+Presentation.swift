// PreviewView+Presentation.swift — the Flag / Info presentation modifiers
// for `PreviewView` (Fast Preview epic, spec §4).
//
// Split out of PreviewView.swift for the file-size budget when the preview
// picked up the editor's `FilmstripRail` (#3402). Both modifiers branch on
// size class so the platform/idiom split stays out of `PreviewView.body`:
// popover / inspector column on regular (Mac/iPad), bottom sheet on compact
// (iPhone).

import SwiftUI
import MapleCore

// MARK: - FlagPresentation

/// Flag surface: popover on regular (desktop/iPad), bottom sheet on compact
/// (iPhone). Both host the shared `RatingFlagsRow`.
struct FlagPresentation: ViewModifier {
    @Binding var isPresented: Bool
    let isRegular: Bool
    let session: EditSession?

    func body(content: Content) -> some View {
        if isRegular {
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                RatingFlagsRow(session: session)
                    .padding(16)
                    .frame(minWidth: 280)
                    .background(MapleTokens.surface)
            }
        } else {
            #if os(iOS)
            content.mapleBottomSheet(isPresented: $isPresented) {
                RatingFlagsRow(session: session)
                    .padding(20)
            }
            #else
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                RatingFlagsRow(session: session).padding(16).frame(minWidth: 280)
            }
            #endif
        }
    }
}

// MARK: - InfoPresentation

/// Info surface: a docked `.inspector` column on regular, bottom sheet on
/// compact — mirroring how `AppShellMacLayout` presents the editor's
/// `DetailPanel` (same modifier, same `.inspectorColumnWidth` clamps) so
/// Preview's pane and the editor's pane read as one thing. Reuses
/// `InfoPanelView` (the S6 panel) directly.
struct InfoPresentation: ViewModifier {
    @Binding var isPresented: Bool
    let isRegular: Bool
    let session: EditSession?

    // Sheet / popover content does NOT inherit custom `EnvironmentKey`
    // values from the presenter the way an inline child does, so the
    // cloud clients injected at the AppShell root (#633 histogram, #2212
    // enrichment) arrive `nil` inside the presented `InfoPanelView` —
    // leaving the description / OCR / transcript section blank on iPhone
    // even for a Self-Hosted asset. Read them here (this modifier IS in
    // the AppShell environment) and re-inject them onto the presented
    // content below. An inspector's content is part of the view tree rather
    // than a separate presentation, so it would inherit these anyway — the
    // explicit re-injection just keeps the regular/compact branches from
    // diverging in a way a later reader has to re-derive.
    @Environment(\.cloudAssetDetailClient) private var detailClient
    @Environment(\.cloudHistogramClient) private var histogramClient
    // #2518 — same sheet non-inheritance applies to the reveal-folder action
    // (clickable path row) and the search action (tappable face names) that
    // the info pane invokes; re-inject both.
    @Environment(\.revealFolderAction) private var revealFolder
    @Environment(\.searchForText) private var searchForText
    // #2638 — the filename row's rename affordance needs the same
    // re-injection across this inspector/sheet/popover boundary.
    @Environment(\.assetRename) private var assetRename

    func body(content: Content) -> some View {
        if isRegular {
            content
                .inspector(isPresented: $isPresented) {
                    InfoPanelView(
                        session: session,
                        isInsideSheet: false,
                        showsCullingAndHistogram: false
                    )
                    .environment(\.cloudAssetDetailClient, detailClient)
                    .environment(\.cloudHistogramClient, histogramClient)
                    .environment(\.revealFolderAction, revealFolder)
                    .environment(\.searchForText, searchForText)
                    .environment(\.assetRename, assetRename)
                    // Same clamps `AppShellMacLayout` applies to the
                    // editor's `DetailPanel` inspector.
                    .inspectorColumnWidth(min: 240, ideal: 280, max: 360)
                }
        } else {
            #if os(iOS)
            content.sheet(isPresented: $isPresented) {
                InfoPanelView(
                    session: session,
                    isInsideSheet: false,
                    showsCullingAndHistogram: false
                )
                .environment(\.cloudAssetDetailClient, detailClient)
                .environment(\.cloudHistogramClient, histogramClient)
                .environment(\.revealFolderAction, revealFolder)
                .environment(\.searchForText, searchForText)
                .environment(\.assetRename, assetRename)
                .presentationDetents([.medium, .large])
            }
            #else
            content.popover(isPresented: $isPresented, arrowEdge: .bottom) {
                InfoPanelView(session: session, isInsideSheet: false)
                    .frame(width: 320, height: 480)
                    .environment(\.cloudAssetDetailClient, detailClient)
                    .environment(\.cloudHistogramClient, histogramClient)
                    .environment(\.revealFolderAction, revealFolder)
                    .environment(\.searchForText, searchForText)
                    .environment(\.assetRename, assetRename)
            }
            #endif
        }
    }
}
