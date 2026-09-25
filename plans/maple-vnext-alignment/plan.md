# Maple VNext alignment plan

## Reference surfaces

- Sketch: `Maple-Browse-Extensions.sketch`, pages `06 · Editor / iOS`, `10 · Editor / Web`, `11 · Preview / iPhone filmstrip`, and `15 · Preview / Web Layouts`.
- Apple: `src/apple/Packages/MapleUI/Sources/MapleUI/Pages/MuiPageEditor.swift` and `MuiPagePreview.swift`, plus the shared organisms they compose.
- Web: `src/web/projects/maple-common/src/lib/shells/editor-shell/`, `preview-shell/`, `ui/pages/editor/`, and `ui/pages/preview/`.

## Alignment goals

1. iPhone duo editor: make the narrow layout feel like the Sketch pair—edge-to-edge file bar, full-bleed image, compact selected-tool controls above a bottom dock, safe-area aware spacing, and no desktop-only inspector chrome.
2. Web editor: keep the canvas-first interaction model, but align platform chrome, rail geometry, panel density, and the left-rail/right-panel composition shown in Sketch.
3. Preview: align iPhone and web preview around the same header, filmstrip, info, edit, and flag actions; preserve the existing route and state wiring.
4. Mac: bring the SwiftUI gallery/editor page composition closer to the duo model without changing pipeline or sidecar behavior.

## Implementation sequence

- Tune shared tokens and shell geometry first so Apple and Web use the same visual vocabulary.
- Update Web editor phone chrome and rail/card placement; add focused responsive regression coverage.
- Update Web preview rail/action/info geometry and empty/loading states.
- Update Apple `MuiPageEditor` and `MuiPagePreview` composition for the same hierarchy.
- Run web format/tests and Swift package tests; build the relevant Xcode target if available.

## Non-goals

- No changes to RAW processing, XMP schema, routing semantics, or cache keys.
- No new feature toggles or speculative abstractions.

## Verification

- Compare phone, web editor, and web preview at the Sketch target widths.
- Exercise edit, preview, filmstrip selection, info, crop, and back actions.
- Confirm desktop/tablet regression coverage remains green.
