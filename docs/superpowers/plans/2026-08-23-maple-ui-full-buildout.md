# Maple UI Full Build-Out — Implementation Plan

> This plan is executed wave-by-wave via agent dispatch (subagent-driven development). Each task
> below is one agent brief building a batch of elements. Waves run in order; batches inside a wave
> run in parallel. The element-level specification lives in
> `docs/unified-component-catalog.md` — every batch brief points agents at the catalog rows plus
> (for atoms) the contract docs under `docs/design/maple-ui/components/`.

**Goal:** Build the entire Unified Component Catalog — 22 atoms, 68 molecules, 52 organisms,
7 templates, 15 pages — as real, working, Canvas-Dark-themed components on Web (Angular /
`maple-common`), then Apple (SwiftUI / new `MapleUI` SPM package), then Windows (WinUI /
`MapleUI` namespace), each platform anchored by a live showcase surface where every element is
rendered and testable as it lands.

**Spec lineage:** `docs/superpowers/specs/2026-08-22-maple-ui-design-system-design.md` (the
foundation spec; its "follow-on plans" section names exactly this work) +
`docs/unified-component-catalog.md` (the element inventory and dependency order — the per-element
spec of record).

## Global rules (bind every batch, every platform)

- **Canvas Dark theming.** Components consume Maple's own tokens — the CSS custom properties /
  `MapleTokens` / XAML resources generated from `ui_tokens.rs` (colors, motion, radius, spacing).
  Never hardcode a hex or pixel that has a token. The cream Just Maple styling in the catalog
  mockups is the _catalog page's_ aesthetic, not the components'.
- **Real components, no placeholder stubs** (CLAUDE.md invariant 6). A batch is done when every
  element in it renders its catalog-specified variants/sizes/states and its showcase specimen
  exercises them.
- **Showcase-as-verification.** Every batch wires its elements into the platform's showcase
  surface in the same change. The showcase card for an element replaces its static mockup with
  live renders (multiple variants/states per card). No separate "wire up later" pass.
- **Contracts for atoms.** Every atom ships with (or already has) a contract doc under
  `docs/design/maple-ui/components/` passing `tools/check-maple-ui-contracts.sh`. Molecules and
  above are specified by their catalog row (purpose + built-from + to-design column); no per-doc
  contract requirement — the catalog is their spec.
- **Dependency order.** A batch may only use elements from earlier waves (the catalog's Built-from
  column is the authority). Organisms/templates/pages are built as presentational, mock-data
  reference implementations in the design-system layer — real app screens migrate to them in
  later, separate work (the spec's Browse/Editor + Settings pilots).
- **Per-wave PRs.** Each wave lands as its own reviewable PR (rebase-clean, green, ticketed).
  A wave's PR merges before the next wave branches (each wave builds on the last).
- **Tests.** Web: vitest specs per component (render + variant/state switching + event outputs).
  Apple: MapleCore-style unit tests where logic exists; showcase compiles for macOS + iOS.
  Windows: builds via CI's windows-x64 job; showcase window renders every element.

## Platform phases

### Phase W — Web (Angular, `maple-common` `lib/ui/`)

Component conventions: standalone, `ChangeDetectionStrategy.OnPush`, signals, `input()`/
`output()`, separate `.ts/.html/.scss`, selector prefix `mui-` (e.g. `<mui-button>`), exported
via `public-api.ts`. SCSS consumes `var(--color-*)` + the generated radius/spacing SCSS vars.
Showcase: the existing `/maple-ui` catalog page (maple-syrup) — each built element's card swaps
its static specimen for live component renders.

| Task | Batch                                | Elements                                                                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0   | Showcase shell                       | —                                                                                                                                                                                                                                                                                                                | DONE-in-progress: catalog page with 7 tabs, ported mockups, tokens tab, contracts section. Finish: fallow fixes (tailwindcss ignoreUnresolvedImports, shared styles partial extraction, shell template split into tier-tokens + atom-contracts child components), commit, push to PR #3001. |
| W1   | Atoms · Actions+Content              | Button, Action Button, Icon, Link, Text, Timestamp, Badge, Stat, Divider, List                                                                                                                                                                                                                                   | Replaces dead `maple-button`. Icon wraps the existing `maple-icon` registry (stroke set) — the icon-system convergence decision stays deferred per the Icon contract.                                                                                                                       |
| W2   | Atoms · Form+Media+Feedback          | Input, Checkbox, Segmented Toggle, Image, Remote Image, Avatar, QR Code, Canvas Surface, Progress, Spinner, Status Text, Toast                                                                                                                                                                                   | Remote Image mocks its tiered loader at showcase level; Canvas Surface hosts a stub GL layer in showcase. New contract docs for the 13 atoms that lack one (both batches).                                                                                                                  |
| W3a  | Molecules L1 · Form & entry          | Form Field, Inline Rename Field, Search Bar, Slider, Living Slider, Drag Bar, Color Wheel, 2-D Pad                                                                                                                                                                                                               | Living Slider/Color Wheel port visual spec from existing editor components where they exist.                                                                                                                                                                                                |
| W3b  | Molecules L1 · Selection + Feedback  | Chip Row, Tabs, Tree Row, List Row, Rating & Flags, Banner, Toast Container, Empty State, Value Chip, Value HUD, Frame-time HUD                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                             |
| W3c  | Molecules L1 · Overlays + Structure  | Popover, Context Menu, Suggestion Menu, Command Menu, Collapsible, Page Header, Toolbar, Bubble Menu, Label-Value Grid, Avatar Group                                                                                                                                                                             | Collapsible may wrap/replace existing `maple-collapsible`.                                                                                                                                                                                                                                  |
| W3d  | Molecules L1 · Plots + Media         | Histogram, Waveform, Parade, Vectorscope, Curve Plot, Connection Graph, Heatmap Layer, Map Annotation, Preview Image, Video Player, Audio Player, Drag Preview, Code Block                                                                                                                                       | Plots render from static sample data in showcase.                                                                                                                                                                                                                                           |
| W4a  | Molecules L2 (1/2)                   | Media Cell, Card, Dialog, Settings Row, Embed Shell, Description Field, Transcript Block, Faces Row, Place Row, Vision Row, Keyword Row, Preview List                                                                                                                                                            |                                                                                                                                                                                                                                                                                             |
| W4b  | Molecules L2 (2/2)                   | Progress Step, Suggestion Preview, Bot Output, Endpoint Form, Response Viewer, Filmstrip Row, Filmstrip Rail, QR Scanner, Chat Message, Typing Indicator, Todo Popover, Event Popover                                                                                                                            |                                                                                                                                                                                                                                                                                             |
| W5   | Templates                            | App Shell, Split Layout, Tab Shell, Settings Shell, Overlay Shell, Sheet Shell, Drawer Shell                                                                                                                                                                                                                     | Region-slot components (ng-content slots), breakpoint behavior per catalog §5.                                                                                                                                                                                                              |
| W6a  | Organisms · Collections+Nav          | Collection Grid, List View, Timeline, Kanban Board, Filmstrip, Search Results, Sidebar, Tool Dock, Search, Filter Panel                                                                                                                                                                                          | Mock-data presentational reference implementations.                                                                                                                                                                                                                                         |
| W6b  | Organisms · Inspectors+Panels        | Inspector, Info, Enrichment, Adjustments, Color Grading, HSL, Tone Curve, Film, Presets, Scopes, Backlinks, Version History, Thread panels                                                                                                                                                                       |                                                                                                                                                                                                                                                                                             |
| W6c  | Organisms · Modals                   | Export, Batch Rename, Batch Metadata, Move To, Panorama Merge, Selective Paste, Library Picker, Add Server, Pair Device, Share, Template Gallery, Card Detail, Result Report                                                                                                                                     | All on Overlay Shell (W5).                                                                                                                                                                                                                                                                  |
| W6d  | Organisms · Editing+Map+Comms+Config | Image Canvas, Crop Overlay, Crop Toolbar, Control Surface, Mobile Control Bar, Rich Text Editor*, Whiteboard Canvas*, Structured Data Editor, Preview Surface, Map Surface, Chat, Notification Feed, Settings Section, Pipeline Monitor, Setup Wizard, User Management, Device List, Backup Monitor, Diagnostics | \*Rich Text/Whiteboard are showcase-grade shells (toolbar + contenteditable / canvas), not full editors.                                                                                                                                                                                    |
| W7   | Pages                                | The 15 catalog pages as template+organism compositions rendered in the showcase's Pages tab                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                             |

### Phase A — Apple (SwiftUI, `src/apple/Packages/MapleUI/`)

New dependency-free local SPM package (per the foundation spec §3): targets `MapleUI`
(components) + `MapleUITests`. Views consume `MapleUITokens` (generated) via a thin
`Color(hex:)`-style layer local to the package (no MapleCore import). Showcase: a
`MapleUIGalleryView` — same 7-tab catalog structure — added to the Maple app behind
Settings → "Maple UI Gallery" (macOS + iOS), plus SwiftUI previews per component.
Waves A1–A7 mirror W1–W7 batch-for-batch, translating the same catalog rows; the Web
implementation is the reference for spacing/variant decisions the catalog leaves open.

### Phase N — Windows (WinUI, `src/windows/Maple.WinUI/MapleUI/`)

`Maple.UI` namespace folder: templated controls + `ResourceDictionary` styles consuming the
generated `Tokens.xaml` resources. Showcase: a `MapleUIGalleryWindow` opened from a new
command (dev menu / keyboard shortcut) rendering all tiers. Waves N1–N7 mirror W1–W7.
Verification is CI's windows-x64 build (no local Windows environment) + structural checks;
the gallery window is the user's manual test surface.

## Execution protocol (per wave)

1. Controller opens a ticket for the wave, branches from fresh `main`.
2. Batches dispatch as parallel agents (one brief per batch; brief = element list + catalog rows
   - conventions + file paths + showcase-wiring instructions + test requirements).
3. Each agent: builds components + specs + showcase wiring, runs the platform's test suite,
   self-reviews, reports.
4. Controller: integrates, runs full gates (tests, format, fallow, budgets), verifies the
   showcase live (web: dev server screenshots per tab; apple: build + gallery screenshots;
   windows: CI), task-reviews per batch, fixes, commits.
5. Wave PR opens ready-for-review; user merges; next wave branches.

## Current status

- W0: in flight on branch `feature/maple-syrup-maple-ui-page` (PR #3001) — catalog shell +
  ported mockups done and verified live; fallow/template-split fixes pending; commit + push next.
- W1/W2 dispatch immediately after W0 lands on the PR.
