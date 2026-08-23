// MuiOverlayShell.swift — Maple UI Templates (unified-component-catalog.md
// §5). Four-region modal layout: Scrim, Header, Body, Footer. The
// general-purpose surface organism-level modals (Export, Batch Rename,
// Batch Metadata, Move To, …) are built on. Regions only — no content of
// its own. `MuiDialog` is a narrower, opinionated specialization of the
// same idea (fixed prompt/confirm copy + actions); this is the general
// shell for everything else.
//
// Dismissal mirrors `MuiDialog`: scrim tap and (macOS only) Escape both
// call `dismissed`, and the panel receives focus on open — factored into
// the shared `muiEscapeDismissible` modifier since Overlay Shell, Sheet
// Shell, and Drawer Shell all need the identical contract.
//
// Scroll containment: Header and Footer are fixed chrome; only Body
// scrolls, so long content never pushes the actions off screen. Sizes
// (`sm`/`md`/`lg`/`full`) map to a max width via `MuiOverlayShellMath`,
// matching the web reference's size classes.

import SwiftUI

public enum MuiOverlayShellSize: Sendable {
    case sm, md, lg, full
}

public struct MuiOverlayShell<Header: View, ContentBody: View, Footer: View>: View {
    public let isPresented: Bool
    public let size: MuiOverlayShellSize
    public let accessibilityLabel: String
    /// Positions the scrim absolutely within the nearest positioned
    /// ancestor instead of covering the whole screen — for demoing/
    /// embedding the shell without it hijacking the whole window (mirrors
    /// `MuiToastContainer`'s `inline` input).
    public let contained: Bool
    /// Fires on Escape (macOS) or an outside (scrim) tap.
    public let dismissed: (() -> Void)?

    public let header: Header
    public let content: ContentBody
    public let footer: Footer

    // `dismissed` is declared LAST, after every `@ViewBuilder` slot — not
    // just for readability. Swift's multiple-trailing-closure matching
    // binds the first unlabeled trailing closure to the first parameter
    // (in declaration order) that doesn't already have a value, regardless
    // of whether it's the one marked `@ViewBuilder`. With `dismissed`
    // declared before `header`, a call like
    // `MuiOverlayShell(isPresented: true) { header } content: { … }` would
    // silently bind the header closure to `dismissed` instead (a real bug
    // caught while writing this file's own `#Preview`s — the header never
    // rendered, with only a stray "unused MuiText" warning as the clue).
    // Ordering every ViewBuilder slot before the plain callback closure
    // avoids the trap entirely.
    public init(
        isPresented: Bool,
        size: MuiOverlayShellSize = .md,
        accessibilityLabel: String = "Dialog",
        contained: Bool = false,
        @ViewBuilder header: () -> Header = { EmptyView() },
        @ViewBuilder content: () -> ContentBody,
        @ViewBuilder footer: () -> Footer = { EmptyView() },
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.size = size
        self.accessibilityLabel = accessibilityLabel
        self.contained = contained
        self.header = header()
        self.content = content()
        self.footer = footer()
        self.dismissed = dismissed
    }

    public var body: some View {
        ZStack {
            if isPresented {
                Color.black.opacity(0.5)
                    .ignoresSafeArea(contained ? [] : .all)
                    .contentShape(Rectangle())
                    .onTapGesture { dismissed?() }
                    .transition(.opacity)
            }

            if isPresented {
                panel.transition(.opacity)
            }
        }
        .animation(MuiTokens.Motion.sheetPresent, value: isPresented)
    }

    private var panel: some View {
        VStack(spacing: 0) {
            if Header.self != EmptyView.self {
                header.padding(MuiTokens.spacingLg).padding(.bottom, 0)
            }

            ScrollView {
                content.padding(MuiTokens.spacingLg)
            }

            if Footer.self != EmptyView.self {
                footer.padding(MuiTokens.spacingLg).padding(.top, 0)
            }
        }
        .frame(maxWidth: MuiOverlayShellMath.maxWidth(for: size).map { CGFloat($0) } ?? .infinity)
        .frame(maxHeight: size == .full ? .infinity : nil)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: size == .full ? 0 : MuiTokens.radiusLg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: size == .full ? 0 : MuiTokens.radiusLg, style: .continuous)
                .stroke(MuiTokens.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.35), radius: 28, y: 12)
        .padding(size == .full ? 0 : MuiTokens.spacingXl)
        .muiEscapeDismissible(onDismiss: dismissed)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }
}

#Preview("MuiOverlayShell — md") {
    ZStack {
        MuiTokens.bg
        MuiOverlayShell(isPresented: true) {
            MuiText("Export photos", variant: .sheetTitle)
        } content: {
            MuiText("Choose a destination and format.", variant: .body, color: .muted)
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) {}
                MuiButton(label: "Export", variant: .primary) {}
            }
        }
    }
}

#Preview("MuiOverlayShell — full, contained") {
    MuiOverlayShell(isPresented: true, size: .full, contained: true) {
        MuiText("Full-screen review", variant: .sheetTitle)
    } content: {
        MuiText("Body content fills the available space.", variant: .body, color: .muted)
    }
    .frame(width: 400, height: 260)
    .background(MuiTokens.bg)
}
