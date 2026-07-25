# Web responsive: one tree, no shell fork

**Date:** 2026-07-25
**Status:** Approved (design phase)
**Scope:** `src/web` — `projects/maple` (Self-Hosted), `projects/maple-syrup` (Hosted), `projects/maple-common` (shared shells)

## Problem

The web app ships two disconnected UIs that meet at a hard 768px cliff. `RootShellComponent`
(`maple-common/src/lib/shells/root-shell.component.ts:31`) switches on `LayoutService.layout()`:

- `< 768px` → `PhoneTabShellComponent` (bottom tab bar: Library / Search / Settings)
- `≥ 768px` → the pane shells (`BrowseShell` / `EditorShell` / `PreviewShell`) via `<router-outlet>`

The two sides don't even share routes — phone navigates to `/library`, `/search`, `/settings`;
desktop lands on `/browse`, `/edit`, `/view`. So it is two component trees, not one that reflows.
The desktop pane shells were never made fluid: `BrowseShell` has zero breakpoint awareness, `Search`
is a phone-width column stretched full-viewport with a fixed-desktop advanced page, and only
`Settings` (and `Preview`) actually collapse.

The goal: **the desktop UI should be responsive** — one component tree that reflows from desktop down
to phone width — rather than a separate mobile shell.

## Current state (audit summary)

| Surface                                | Verdict                           | Key evidence                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse/Library (`/browse`)             | Fixed-desktop                     | Hardcoded `220px` sidebar (`browse-shell.component.html:206`); ~10 non-wrapping toolbar controls; `min-w-[220px]` search. No `@media`, no `LayoutService`.                                                                                        |
| Search (`/search`, `/search/advanced`) | Not responsive                    | `<app-search>` has no `max-width`, grid hardcoded `repeat(3,1fr)` (`search/photo-results-section.component.scss:35`). `/search/advanced` is `h-screen w-screen` with fixed `260px` sidebar + non-wrapping 14-control toolbar, no phone treatment. |
| Settings (`/settings/**`)              | Responsive (reference pattern)    | `settings-shell` 3-tier `@media`: sidebar `240 → 196 → 0px` horizontal strip. Two phone bugs (below).                                                                                                                                             |
| Editor (`/edit`)                       | Responsive on its own breakpoints | Layered canvas; private `innerWidth` observer at `768/1100` (`editor-shell-chrome.ts:81`), not `LayoutService`. Phone branch currently unreachable on web.                                                                                        |
| Preview (`/view`)                      | Responsive                        | Uses `LayoutService` correctly (`preview-shell.component.ts:96`).                                                                                                                                                                                 |

Breakpoints (`layout-service.ts:25-27`): `<768` phone, `768–1024` tablet, `>1024` desktop. These
match the Settings `@media` cutoffs (767/1023) and mirror Apple `MapleLayout.from(width:)`.

## Target architecture

**One responsive component tree, no shell fork.**

1. **Retire the fork.** `RootShellComponent` stops switching on `layout()`; it always renders
   `<router-outlet>` plus the update-toast and LAN-switch banner it already hosts.
   `PhoneTabShellComponent` and the phone-tab route set are deleted.

2. **Consolidate routes.** `/library` → redirect to `/browse` (BrowseShell is the single library
   surface at every width). `/search` and `/settings` already serve both tiers. One route table per
   app, no phone-only entries.

3. **One breakpoint source of truth — hybrid by role.**
   - **CSS `@media`** (768/1024) for pure visual reflow: column counts, paddings, hiding labels.
     This is the proven Settings-shell pattern.
   - **`LayoutService.layout()` signal** only where component _structure/behavior_ changes:
     sidebar-as-pane vs sidebar-as-overlay-drawer, info-as-pane vs info-as-bottom-sheet.
     `EditorShell`'s private `768/1100` observer is replaced by `LayoutService` so all shells agree.

4. **Navigation on narrow screens.** With the bottom-nav retired, the collapsed desktop chrome _is_
   the navigation at every width: the Browse toolbar's source sidebar collapses into a
   hamburger → overlay drawer (reusing the existing `SourcePickerDrawer` primitive), and the
   toolbar's action buttons collapse into an overflow/kebab menu below the breakpoint. Search and
   Settings stay reachable from the toolbar exactly as on desktop today. No new nav surface is
   invented.

## Per-surface work

### BrowseShell (largest change)

- Source sidebar: replace the inline `220px` (`browse-shell.component.html:206`) with breakpoint-
  driven width — full on desktop, narrowed on tablet, and an **overlay drawer** (`SourcePickerDrawer`)
  triggered by a toolbar hamburger below the phone breakpoint (`LayoutService`-driven open/close).
- Toolbar: the action pills (Edit Metadata, Merge to panorama, Copy/Paste/Sync Settings, Export)
  collapse into an **overflow/kebab menu** below a breakpoint; the `min-w-[220px]` search shrinks or
  becomes an expandable icon.
- Grid: already fluid via `ResizeObserver` — unchanged.

### Search

- `/search` (`<app-search>`): add a `max-width` container; replace the hardcoded `repeat(3,1fr)`
  photo grid with `repeat(auto-fill, minmax(…,1fr))` so it reflows across widths.
- `/search/advanced` (`SearchComponent`): fixed `260px` sidebar → collapsible drawer; non-wrapping
  14-control toolbar → wrap/overflow. Scope-chip (`places`/`people`/`albums`) and top-hits stubs stay
  as-is — backend-gated, out of scope.

### Settings

- Keep as the reference responsive pattern. Fix/verify the two phone bugs:
  - `settings-shell.component.scss:15` `height:100vh` → `100%` of its container so nested content
    isn't clipped.
  - People bulk toolbar offset (`people.component.scss:776`).
  - Both likely resolve for free once the bottom tab bar is gone; the ticket is primarily to verify
    at phone width.

### EditorShell / PreviewShell

- Editor: swap the private `768/1100` `innerWidth` observer (`editor-shell-chrome.ts`) for
  `LayoutService`; its already-built phone branch becomes reachable by narrowing. Verify it activates
  on live resize, not only at load.
- Preview: already `LayoutService`-driven — verify only.

### Cleanup (dead code)

- Delete `phone-tab-shell.*`, `phone-library-stub`, `phone-search-stub`, `phone-settings-stub`,
  `tab-bar-visibility.service`, and RootShell's phone branch. De-export removed symbols from
  `public-api.ts:113-115`.
- **Keep** `bottom-sheet` (Preview/Info still use it on phone) and `source-picker-drawer` (now reused
  by BrowseShell).

### Hosted (maple-syrup)

- Replace the `/settings` stub (`app.routes.ts:51`, `PhoneSettingsStubComponent`) with a real
  settings surface via the shared settings-shell (Account at minimum).
- Add `ng build maple-syrup` to `.github/workflows/web.yml` so Hosted is CI-covered.

## Verification

- `bun run test` (`ng test maple`) + Prettier `format:check` (the only style gate).
- Spec tests for the `LayoutService`-driven structural switches (drawer vs pane, sheet vs pane).
- Playwright driving the real dev server (dev-login `MAPLE_DEV_AUTH=1`, per project memory) at phone /
  tablet / desktop widths: assert no horizontal overflow, drawer open/close, and nav reachability;
  capture screenshots at the three widths.
- Watch the file-size budget (`CONTRIBUTING.md`) — these shells are large; split if a change pushes a
  file over.

## Slicing (epic + independently-mergeable tickets)

1. **Foundation** — drop the fork in `RootShellComponent`, consolidate routes, move EditorShell onto
   `LayoutService`, retire dead phone-shell code, de-export. (Spine; others build on it.)
2. **BrowseShell fluid** — sidebar → drawer + toolbar overflow.
3. **Search fluid** — `/search` grid + `max-width`; `/search/advanced` sidebar + toolbar collapse.
4. **Settings phone verify/fix** — the two phone bugs (mostly verification post-fork).
5. **Hosted** — real maple-syrup `/settings` + maple-syrup into CI.

Slices 2–5 are independent once slice 1 lands. Each closes its own GitHub ticket per repo convention;
the set lands under one epic.

## Non-goals (YAGNI)

- No new global navigation surface; the collapsed desktop chrome is the nav.
- No backend work for the stubbed search scopes / top-hits.
- No redesign of the Editor (canvas-first editor stays as-is); only its breakpoint source changes.
- No new abstraction layer for breakpoints beyond the existing `LayoutService` + `@media`.
