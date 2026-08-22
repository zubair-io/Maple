# Maple UI: a shared, cross-platform design system

**Status:** Draft — sub-project 1 of a larger initiative
**Date:** 2026-08-22

## Context

Maple ships on three platforms — Apple (SwiftUI), Web (Angular), Windows (WinUI) — from one Rust
color/motion core. Design tokens are (mostly) single-sourced, but the UI *components* built on top
of them are not: each platform, and often each screen within a platform, hand-rolls its own
buttons, rows, and chrome.

An audit of the current state (2026-08-22) found:

- **Web** already has a shared component library (`maple-common`: `maple-button`,
  `maple-collapsible`, `maple-icon`, banners, dialogs) — but adoption is close to zero.
  `<maple-button>` is used nowhere in the app outside its own Storybook story. Settings alone
  accounts for 93 of the app's 102 raw `<button>` elements; `btn-primary`/`btn-ghost` CSS is
  hand-duplicated in three separate files. Even `maple-common`'s own feature components
  (`develop/`, `editor/`, `info/`) fall back to raw button markup in places.
- **Apple** has no shared component library. `DesignTokens.swift` exposes raw color/font/spacing
  constants plus exactly two reusable views (`StarView`, `FlagBadge`) and one modifier. Settings
  screens mix native `Form`/`Section` idioms, ad-hoc `HStack`/`VStack` builds, and one file-local
  reusable row struct (`PhoneSettingsView.SettingsMenuRow`) that nothing outside that file can use.
- **Windows** has no Settings screen at all yet, no `UserControl`s, and a thin style layer: four
  styles genuinely shared via `Themes/Tokens.xaml`, plus two more (`FloatingPill`, `PillButton`)
  that look shared but are actually scoped to `MainWindow.xaml` alone.
- Token coverage is also incomplete: `ui_tokens.rs` single-sources colors and motion, but not
  radii or spacing — those are ad hoc per platform today. Windows' color/motion tokens are
  hand-mirrored in `Themes/Tokens.xaml` rather than codegen'd, a drift risk already flagged in that
  file's own comment (tracked under milestone #22).

Separately, a "Just Maple" (self-hosted notes app, Angular) sibling product commissioned a
**Unified Style Guide** design artifact (`claude.ai/design` project `288a7180…`) proposing shared
chrome tokens — accent color, radii, motion timings, elevation rules, Material Symbols Rounded
iconography — across both products, while explicitly preserving Maple's near-black "Canvas Dark"
editor surroundings for color-accuracy work (its own principle 5: "Precision on canvas"). Maple's
current accent (`#c4493a`) is already close to that guide's Canvas Dark accent (`#c1493a`);
typography (Lato UI / Merriweather reading) is already adopted on Apple and Web. The guide is a
*reference for shared values*, not a mandate to re-skin Maple into the notes app's cream/paper
theme.

The user's actual goal is broader than tokens: a real, enforced **atomic design system** —
atoms → molecules → organisms → templates — implemented natively on each platform against one
shared contract, so a new screen is built *from* the system instead of improvising alongside it.
And it needs to be shareable: Maple is one of a family of apps (SugarMaple, MapleRecorder,
MapleBricks — all SwiftUI; Just Maple — Angular/web), several of which are real, current consumers
of a shared Apple or Web component library, not hypothetical future ones.

## Goals

1. Single-source the tokens that aren't single-sourced yet (radii, spacing), and close the Windows
   codegen gap so all three platforms build color/motion/radii/spacing from one source.
2. Define **Maple UI**: an atom-tier component set (Button, Input, Icon, Badge, Toggle, Checkbox,
   Select, Divider, list-row primitive) specified once and implemented natively on each platform
   against that spec.
3. Structure the Apple and Web implementations so they are genuinely extractable to standalone,
   independently-versioned packages — because real sibling apps are waiting to consume them — while
   keeping Windows as an internal-only boundary until a second WinUI app exists.
4. Build an enforcement mechanism so Maple UI doesn't suffer `maple-button`'s fate: shipped, correct,
   and unused.
5. Prove the system on a real, cross-platform-complete surface (Browse/Editor) before rolling it
   out further; use Settings as a second, harder migration target in parallel.

## Non-goals (this sub-project)

- Molecules, organisms, and templates/pages. These come after the atom tier is proven — building
  all tiers on all three platforms at once is too large a first slice and the higher tiers should
  be informed by what real screens (Browse/Editor, Settings) actually need.
- Actually integrating Maple UI into Just Maple, SugarMaple, MapleRecorder, or MapleBricks. Those
  are separate repositories outside this session. This sub-project makes the Apple and Web packages
  *ready* to be consumed (clean boundaries, no Maple-app coupling); the follow-up repo split and the
  other repos' adoption are tracked separately.
- A Windows publishing/extraction story. No second WinUI app exists yet — Windows gets the same
  internal class-library discipline as the other platforms, not a repo split.
- Automated cross-platform *visual* parity testing (screenshot-diffing a SwiftUI view against an
  Angular one). The existing color-pipeline and XCUITest visual harnesses test canvas/image
  rendering, not chrome; a chrome parity harness is a plausible future follow-up, not in scope here.
- Migrating every existing screen. Only Browse/Editor (primary pilot) and Settings (secondary) are
  in scope for this sub-project; the rest of each app keeps its current bespoke UI until later
  sub-projects reach it.
- Re-theming Maple into Just Maple's light/cream palette. Canvas Dark stays; only the shared chrome
  tokens (accent, radii, motion, elevation rules, spacing scale) are adopted from the unified guide.

## Architecture

### 1. Foundation tokens

Extend `src/raw-pipeline/raw-core/src/ui_tokens.rs` with two new token tables, `RADIUS_TOKENS` and
`SPACING_TOKENS`, following the existing `COLOR_TOKENS`/`MOTION_TOKENS` pattern (name, value, doc
comment). Values come from the unified guide, cross-checked against what Maple's own screens
already use in practice (radii should not regress any existing visually-approved surface):

- Radii: 4 (chips/pills), 6 (icon buttons/hover targets), 8 (buttons/inputs/cards — the workhorse
  default), 12 (composer/dialogs/panels), 16 (feature cards), 24 (hero/large panels), full (round).
- Spacing: 4, 8, 16, 24, 32, 48 (the 4px-grid steps already implied across the codebase).

Extend `src/raw-pipeline/codegen` with a **`winui` emit target** alongside the existing Swift/TS
emitters, generating `Themes/Tokens.xaml` instead of it being hand-mirrored. This closes the
drift risk called out in that file's own comment and is folded into this work rather than done as
a separate ticket, since the radius/spacing addition touches the same codegen machinery anyway.
The `codegen-drift` CI job picks up the new target automatically (it diffs generated output against
committed files for whatever targets exist).

Accent color: keep Maple's current `#c4493a` as-is. It's already close enough to the guide's
Canvas Dark accent (`#c1493a`) that changing it is a cosmetic nit with no product upside, and the
guide itself describes Maple's *existing* editor as the source for that register — it isn't asking
for a change.

### 2. Component contract format

Each Maple UI atom gets one markdown spec, committed to `docs/design/maple-ui/components/<atom>.md`,
covering:

- **Identity**: name, one-line purpose, which atomic tier.
- **Variants**: e.g. Button — primary / secondary / ghost / destructive.
- **States**: default, hover, pressed, focused, disabled — referencing the interaction-state rules
  already documented in the unified guide (hover fill, primary-button lift, focus ring, etc.).
- **Tokens used**: which color/radius/spacing/motion tokens it consumes — no hand-picked hex values
  or magic numbers inside a component implementation.
- **Props/parameters**: the conceptual API (e.g. `variant`, `label`, `icon`, `disabled`, `onPress`)
  — described in prose/table, not framework syntax, so all three platforms implement the same
  surface through their own idioms (a SwiftUI `Button` style vs. an Angular `@Input()` vs. a WinUI
  dependency property).
- **Accessibility requirements**: minimum touch target, focus order, label requirements.

This is a **documentation contract, not a generated scaffold**. A codegen-driven approach (schema →
per-platform stub) was considered and rejected for this sub-project: it's substantially more
tooling investment than the flat-value token codegen it would extend, and the audit's actual
finding wasn't "the spec was unclear" (Web's button is fine) — it was "nothing enforced its use."
Scaffolding generation doesn't fix an adoption problem. Revisit only if hand-written spec docs
prove to drift from implementation in practice.

### 3. Per-platform package shape

| Platform | Known consumers today | Package shape | Extraction plan |
|---|---|---|---|
| **Apple** | Maple, SugarMaple, MapleRecorder, MapleBricks (all SwiftUI) | New local SPM package `src/apple/Packages/MapleUI/`, zero dependencies on `MapleCore` or any Maple-specific type | Split into its own git repo as soon as the atom tier is stable enough for a sibling app to start consuming it (tagged releases via SPM's normal git-dependency support). Not done in this sub-project — the package must exist and be proven internally first — but tracked as a near-term follow-up, not indefinitely deferred. |
| **Web** | Maple, Just Maple (both Angular) | Existing `maple-common` library project; new/refactored atom components must avoid importing app-specific services/models, matching what already (mostly) holds for its non-atom code | Already structurally extractable via the workspace's library-project boundaries (ng-packagr). No new machinery needed in this sub-project. |
| **Windows** | Maple only | Internal WinUI class-library boundary (styles + `UserControl`s grouped under one `MapleUI` namespace/folder, not scattered through `MainWindow.xaml`) | None — no second consumer exists. Revisit if/when a second WinUI app appears. |

Naming: the system and each platform's package are called **Maple UI** (Swift target `MapleUI`,
Angular library import path kept under `maple-common` for now since it's not being physically
split, Windows namespace `Maple.UI`).

### 4. Enforcement

Without this, Maple UI risks repeating `maple-button`'s fate. Two mechanisms, one per surface type:

- **Web**: a CI check (new script under `src/web/scripts/`, wired into the existing test/format
  gates) that greps app-project `.html` files (excluding `maple-common` itself) for raw
  `<button`, `<input`, and known ad-hoc classes (`btn-primary`, `btn-ghost`, etc.) and fails with a
  pointer to the Maple UI equivalent. Scoped to the pilot surfaces (Browse/Editor, Settings) as they
  migrate — turning it on repo-wide on day one would fail on every untouched screen.
- **Apple**: no direct lint equivalent for SwiftUI view bodies exists in this repo's toolchain.
  Instead, a `docs/best-practices.md` § Swift addition naming Maple UI as the required source for
  buttons/badges/rows/etc. in any *new or touched* view, enforced at code review — paired with
  deleting `DesignTokens.swift`'s two ad-hoc views (`StarView`, `FlagBadge`) once their Maple UI
  equivalents ship, so the old pattern can't be copy-pasted forward.
- **Windows**: same code-review-based rule, plus deleting `MainWindow.xaml`'s locally-scoped
  `FloatingPill`/`PillButton` styles once replaced, for the same reason.

A future automated Apple/Windows check (e.g. a script scanning for raw `HStack`/`Button`
construction patterns) is a plausible follow-up but not required to start — the review-gate is
sufficient for the pilot's scope (two surfaces, not the whole app).

### 5. Pilot targets

- **Primary: Browse/Editor.** The only surface that's fully built out on all three platforms today,
  making it the real cross-platform parity test — grid/filmstrip rows, control-rail buttons,
  toggles, chips, panel containers all exercise the atom tier in a way Settings' simpler forms
  don't.
- **Secondary: Settings.** Confirmed worst offender on Web (0% shared-component adoption) and Apple
  (mixed native/ad-hoc). Windows has no Settings screen yet — it gets built directly on Maple UI as
  a greenfield example rather than migrated, which also gives an early "does a brand-new screen
  built purely from Maple UI actually look consistent with the other two platforms" check before a
  harder migration is attempted anywhere else.

## Testing / verification

- `codegen-drift` CI job extends automatically to cover the new `winui` target and the new
  radius/spacing tokens — no new job needed, just new coverage of the existing one.
- Per-atom manual verification: build each atom on each platform, screenshot side-by-side against
  its spec doc and the other two platforms' renderings. This is a review step, not an automated
  gate (see Non-goals — automated visual parity across three rendering engines is out of scope).
- Web enforcement check runs in CI once wired up (see §4); a failing check blocks the PR that
  introduced the new raw markup.
- No changes to the color-pipeline or XCUITest visual harnesses — this work doesn't touch scene-referred
  color math or canvas rendering, so those gates are unaffected and don't need to pass on chrome-only
  changes beyond their normal build-still-compiles requirement.

## Open questions

- Exact radius/spacing values above are drawn from the unified guide; if any conflict with a
  currently-shipped, visually-approved Maple surface (e.g. a control-rail width baked into the
  editor layout), the existing shipped value wins for that specific surface and the token gets a
  documented exception rather than forcing a regression — to be confirmed per-value during
  implementation, not resolved here.
- The exact point at which the Apple package splits into its own repo (which sibling app adopts it
  first, what versioning/release process it uses) is intentionally left to the follow-up work
  described in §3, not decided in this spec.
