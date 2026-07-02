//! Canonical UI design tokens (colors + motion) shared across the Swift
//! shell, the Angular shell, and any future surface.
//!
//! Ticket #606 (KTLO). Before this lived as three hand-mirrored files —
//! `src/apple/Maple/Views/DesignTokens.swift`,
//! `src/web/projects/maple-common/src/lib/tokens.{ts,scss}` (with `motion.{ts,scss}`
//! adjuncts from S0a / #581) — which silently drifted whenever someone
//! added a token to only one platform. The constants here are the single
//! source of truth; `tools/codegen.sh` emits per-platform files under
//! each project's `Generated/` directory.
//!
//! Scope: hex color strings (lowercase, leading `#`), CSS rgba strings,
//! integer milliseconds, and CSS easing-function strings. Pure values —
//! no SwiftUI / CSS types here. Consumers wrap them at call sites
//! (`Color(hex:)` in Swift, `var(--color-...)` in SCSS, the `MapleMotion`
//! object shape in TS).
//!
//! Out of scope: typography (depends on bundled fonts referenced by
//! family name; not currently drift-prone) and spacing (Apple-only
//! today; web uses Tailwind utility classes). These can join later
//! without breaking the existing shape — see ticket #606 description.

// -------------------------------------------------------------------------
// Colors
// -------------------------------------------------------------------------

/// A single UI color token. `value` is the literal string emitted to all
/// three targets (hex like `#1c1917` or `rgba(...)` — CSS understands both,
/// and Swift's `Color(hex:)` is taught to strip a leading `#`).
pub struct ColorToken {
    /// snake_case key. Mapped to camelCase in Swift/TS, kebab-case in SCSS.
    pub name: &'static str,
    pub value: &'static str,
    pub doc: &'static str,
}

/// Every color the shells reference. Order is the canonical render order —
/// generated files keep this ordering for reviewability.
pub const COLOR_TOKENS: &[ColorToken] = &[
    // --- Surfaces ---
    ColorToken {
        name: "bg",
        value: "#1c1917",
        doc: "Window / app background.",
    },
    ColorToken {
        name: "surface",
        value: "#262524",
        doc: "Default panel surface.",
    },
    ColorToken {
        name: "surface_alt",
        value: "#2e2c2a",
        doc: "Alternate / nested panel surface.",
    },
    ColorToken {
        name: "surface_hover",
        value: "#3a3836",
        doc: "Hover state for surface elements.",
    },
    ColorToken {
        name: "sidebar",
        value: "#292524",
        doc: "Sidebar / tree column background.",
    },
    ColorToken {
        name: "input_bg",
        value: "#1c1917",
        doc: "Text-input fill (matches window bg).",
    },
    ColorToken {
        name: "image_canvas",
        value: "#141210",
        doc: "Image-canvas backdrop behind the loupe.",
    },
    // --- Text ---
    ColorToken {
        name: "text_main",
        value: "#e7e5e4",
        doc: "Primary text color.",
    },
    ColorToken {
        name: "text_muted",
        value: "#a8a29e",
        doc: "Secondary / metadata text color.",
    },
    // --- Borders ---
    ColorToken {
        name: "border",
        value: "#44403c",
        doc: "Default border / divider.",
    },
    ColorToken {
        name: "border_hi",
        value: "#5a5552",
        doc: "Active ticks (drag-bar center tick), grab handles. \
              Responsive-program S0a (#581). One tier up from `border` \
              to preserve contrast headroom.",
    },
    // --- Accent ---
    ColorToken {
        name: "primary",
        value: "#c4493a",
        doc: "Brand primary (selection, primary action).",
    },
    ColorToken {
        name: "primary_dim",
        value: "#422016",
        doc: "Dimmed primary (hover-of-selected, badge fill).",
    },
    // --- Semantic signals ---
    ColorToken {
        name: "warn",
        value: "#fbbf24",
        doc: "Low-confidence signals (e.g. person detection chips). \
              Tailwind amber-400. Responsive-program S0a (#581).",
    },
    // --- Overlays (rgba) ---
    // CSS literal `0.1` (not `0.10`) — prettier normalizes the longer form
    // and we want emitted files to round-trip through `prettier --check`.
    ColorToken {
        name: "bg_hover",
        value: "rgba(255, 255, 255, 0.06)",
        doc: "Hover overlay (white at 6% opacity).",
    },
    ColorToken {
        name: "bg_active",
        value: "rgba(255, 255, 255, 0.1)",
        doc: "Active / pressed overlay (white at 10% opacity).",
    },
    // --- Semantic banner tints ---
    ColorToken {
        name: "success_bg",
        value: "rgba(34, 197, 94, 0.15)",
        doc: "Success banner fill.",
    },
    ColorToken {
        name: "success_text",
        value: "#4ade80",
        doc: "Success banner text.",
    },
    ColorToken {
        name: "error_bg",
        value: "rgba(239, 68, 68, 0.15)",
        doc: "Error banner fill.",
    },
    ColorToken {
        name: "error_text",
        value: "#f87171",
        doc: "Error banner text.",
    },
    // Lowercase hex — prettier normalizes to lowercase, and we want emitted
    // files to round-trip through `prettier --check`.
    ColorToken {
        name: "star",
        value: "#ef9f27",
        doc: "Star-rating glyph color.",
    },
];

// -------------------------------------------------------------------------
// Motion
// -------------------------------------------------------------------------

/// A motion token (duration + easing string).
///
/// Durations are integer milliseconds — Swift wraps as `Animation` with
/// `duration: Double(ms) / 1000.0`, SCSS emits `<ms>ms`, TS uses the raw
/// integer.
///
/// `ease` is a CSS easing-function string. Swift translates the
/// `cubic-bezier(...)` ones via `Animation.timingCurve(...)`; the named
/// easings (`ease-in-out`, `ease-out`, `linear`) map to
/// `Animation.easeInOut` / `easeOut` / `linear` at the call site.
pub struct MotionToken {
    pub name: &'static str,
    pub ms: u32,
    pub ease: &'static str,
    pub doc: &'static str,
}

/// Responsive-program S0a (#581). Duration + easing tokens for shell
/// transitions, sheet present/dismiss, group/tool swap, chrome hide,
/// filter fade.
pub const MOTION_TOKENS: &[MotionToken] = &[
    MotionToken {
        name: "drawer",
        ms: 240,
        ease: "cubic-bezier(0.22, 1, 0.36, 1)",
        doc: "Drawer open/close (sidebar collapse on tablet/desktop). \
              Not used on phone (tab-bar shell has no drawer).",
    },
    MotionToken {
        name: "push",
        ms: 320,
        ease: "cubic-bezier(0.32, 0.72, 0, 1)",
        doc: "Push transition (iOS-system feel).",
    },
    MotionToken {
        name: "sheet_present",
        ms: 320,
        ease: "cubic-bezier(0.32, 0.72, 0, 1)",
        doc: "Sheet present.",
    },
    MotionToken {
        name: "sheet_dismiss",
        ms: 280,
        ease: "cubic-bezier(0.32, 0.72, 0, 1)",
        doc: "Sheet dismiss.",
    },
    MotionToken {
        name: "group_swap",
        ms: 120,
        ease: "ease-in-out",
        doc: "Editor group/tool tab swap.",
    },
    MotionToken {
        name: "chrome_hide",
        ms: 180,
        ease: "ease-out",
        doc: "Loupe chrome auto-hide.",
    },
    MotionToken {
        name: "filter_fade",
        ms: 120,
        ease: "linear",
        doc: "Library filter chip change cross-fade.",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_tokens_are_non_empty_and_unique() {
        assert!(!COLOR_TOKENS.is_empty());
        let mut names: Vec<&str> = COLOR_TOKENS.iter().map(|t| t.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "duplicate color-token name");
    }

    #[test]
    fn motion_tokens_are_non_empty_and_unique() {
        assert!(!MOTION_TOKENS.is_empty());
        let mut names: Vec<&str> = MOTION_TOKENS.iter().map(|t| t.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "duplicate motion-token name");
    }

    #[test]
    fn color_values_look_like_hex_or_rgba() {
        for tok in COLOR_TOKENS {
            let v = tok.value;
            assert!(
                v.starts_with('#') || v.starts_with("rgba("),
                "color `{}` has value `{}` — expected `#...` or `rgba(...)`",
                tok.name,
                v,
            );
        }
    }

    #[test]
    fn known_tokens_present() {
        // Spot-check that the headline S0a additions survived the move.
        assert!(COLOR_TOKENS.iter().any(|t| t.name == "border_hi"));
        assert!(COLOR_TOKENS.iter().any(|t| t.name == "warn"));
        assert!(MOTION_TOKENS.iter().any(|t| t.name == "drawer"));
        assert!(MOTION_TOKENS.iter().any(|t| t.name == "filter_fade"));
    }
}
