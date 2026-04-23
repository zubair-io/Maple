# Dark Mode — Product Requirements Document

**Status:** Draft
**Owner:** Zubair
**Last updated:** 2026-04-22
**Audience:** Product, Design, Engineering

---

## Summary

Dark Mode is a first-class, full-surface theme for Just Maple that mirrors the warmth of the default Cream light theme in a low-light, low-glare palette. It is the single opt-in alternative theme covered by this doc. Scope is the full dark mode system: tokens, every surface and component, the settings affordance to turn it on, persistence, and platform-level polish (iOS status bar, scrollbars, embedded widgets).

This PRD is intentionally product-focused. It defines *what* dark mode must be and *why*, not the implementation. The existing engineering theming system (`ThemeService` + CSS custom properties in `styles.scss`) is the delivery vehicle, and is documented separately in `docs/eng-theming.md`.

---

## Background & context

Just Maple's visual identity is built around warm, organic light surfaces — Cream `#fdfbf7` backgrounds, Maple Red `#993629` accents, Merriweather serif for long-form editor content. This works beautifully in daylight, but creates three recurring problems for users:

1. **Evening / low-light use is uncomfortable.** A bright cream canvas at 11pm is fatiguing. Power users writing or journaling late report eye strain and manually lower their display brightness.
2. **OLED and battery cost on mobile.** On iOS and modern MacBook Pro displays, a predominantly white surface draws significantly more power than a dark one.
3. **Environmental mismatch.** Users who keep their OS in dark mode experience a jarring "bright flash" whenever they open Just Maple alongside system apps that respect the setting.

Dark mode is already the single most requested theming feature in user feedback. The codebase has partial dark support today — CSS tokens, a `ThemeService`, and a `.dark` class — but coverage across components and content embeds is inconsistent, and it is not discoverable in the product.

---

## Goals

Dark mode should feel like Just Maple, not like a color-inverted approximation. Specifically:

1. **Warmth preserved.** Dark backgrounds use warm stone/charcoal tones (`#1c1917` and up), never pure black. The maple-leaf identity must read through.
2. **Complete surface coverage.** Every view, modal, widget, toolbar, embed, scrollbar, selection, focus ring, and status indicator renders correctly in dark mode. No unstyled white flashes, no illegible text, no hardcoded light-theme colors leaking through.
3. **Legibility and accessibility.** Body text maintains a minimum 4.5:1 contrast ratio (WCAG AA) against its background, and 3:1 for large text and UI elements. Focus rings, selection, and status colors are at least as legible in dark mode as in light.
4. **One-click opt-in.** Users can turn dark mode on from a single, obvious control in Settings. The choice persists across sessions and devices tied to the account.
5. **Native app integration.** On iOS, the status bar, safe-area backgrounds, and splash screen align with the active theme. The web `<meta name="theme-color">` tag updates accordingly.
6. **No performance regression.** Switching themes is instant (<100ms perceived). The editor and whiteboard render at the same frame rate in both themes.

---

## Non-goals

To keep scope honest, the following are explicitly out of scope for this PRD:

- **System-preference auto-following.** Per product decision, dark mode is a manual opt-in only. `prefers-color-scheme` detection is not part of this launch.
- **Per-notebook or per-page theming.** Dark mode is an account-level preference, not a per-document override.
- **Additional themes.** Solarized, Warm, Cool, Rose, Forest and other accent variants already exist in the codebase but are separate efforts; this PRD covers only the Dark theme.
- **Scheduled / time-based switching.** No "switch at sunset" automation.
- **Custom user-authored themes.** Users cannot define their own color palettes.
- **High-contrast / accessibility-specific theme.** A dedicated high-contrast variant is a future consideration.
- **Print styles.** Printing always uses light-theme output regardless of active theme.

---

## User stories

The design must serve these primary stories:

- *As a late-night journaler*, I want to switch Just Maple to a dark theme so that writing at night doesn't strain my eyes or flood my room with light from the screen.
- *As a user whose OS is in dark mode*, I want Just Maple to match the rest of my desktop so the app doesn't feel visually out of place.
- *As a mobile user on an OLED iPhone*, I want dark mode so the app uses less battery and looks at home in the iOS dark aesthetic.
- *As someone sharing my screen in a dark meeting room*, I want a non-glaring theme so my screen isn't a distraction to others.
- *As a user who has configured dark mode*, I want the setting to stick — across sessions, across devices, across app updates — without me having to re-enable it.
- *As any user*, I want dark mode to feel like the same product — the same warmth, the same brand character — not a generic inverted shell.

Secondary stories:

- *As a user*, when I view an embedded widget (recording, whiteboard, kanban, bot output), I want it to respect dark mode rather than rendering a jarring white rectangle inside my dark page.
- *As a user*, when I select text or focus an input, the highlight colors should remain clearly visible in dark mode.

---

## Design principles for Dark Mode

Five principles guide every visual decision:

1. **Warm, not cold.** Backgrounds come from the stone family (`#1c1917`, `#262524`, `#2e2c2a`), not neutral slate or pure black. This preserves the maple-leaf warmth.
2. **Elevation through lightness, not shadow.** In light mode, elevation reads as drop shadow. In dark mode, elevation reads as a *lighter* surface. Cards and modals sit on progressively lighter tones rather than casting shadows.
3. **Accent restraint.** Maple Red `#993629` remains the accent. Where the light theme uses a tinted primary background (`--color-primary-light`), dark mode uses a dark tinted red (`#422016`) — the accent should highlight, not shout.
4. **Status colors brighten.** Red, green, and blue status indicators shift to their lighter / more saturated variants on dark surfaces (`#f87171`, `#4ade80`, brighter blue) so they remain legible.
5. **No pure black, no pure white.** Pure `#000000` creates harsh, CRT-like contrast against the warm brand. Text uses Stone 200 (`#e7e5e4`), never `#ffffff`.

---

## Requirements

### Functional

| # | Requirement |
|---|-------------|
| F1 | A **Dark mode** toggle exists in Settings. When on, the entire app renders in the dark theme. |
| F2 | The user's dark-mode choice persists across sessions on the same device. |
| F3 | The user's dark-mode choice syncs to their account so it applies on other signed-in devices. |
| F4 | Theme switching is applied globally and instantly — no full page reload, no partial repaint. |
| F5 | Every route, modal, popover, tooltip, and drawer in the app renders correctly in dark mode. |
| F6 | Every embedded widget (recording, whiteboard, kanban, bot output, memo embed, paper embed, gcal, connection graph) renders correctly in dark mode. |
| F7 | The native iOS status bar, splash screen, and safe-area backgrounds match the active theme. |
| F8 | The web `<meta name="theme-color">` tag updates when the theme changes so that mobile browser chrome matches. |
| F9 | Onboarding and unauthenticated surfaces (login, signup, password reset) also support dark mode. |

### Visual / design

| # | Requirement |
|---|-------------|
| V1 | Page background: `#1c1917` (stone 950). |
| V2 | Card/surface: `#262524`. Alt surface / code blocks: `#2e2c2a`. |
| V3 | Primary text: `#e7e5e4` (stone 200). Muted text: `#a8a29e` (stone 400). |
| V4 | Borders: `#44403c` (stone 700). |
| V5 | Primary accent: `#993629` (unchanged). Tinted primary surface: `#422016`. |
| V6 | Status colors shift to bright variants: success `#4ade80`, error `#f87171`, with 20%-opacity matching backgrounds. |
| V7 | Scrollbar thumb: `rgba(168, 162, 158, 0.2)`, hover `0.4`. |
| V8 | Text selection: `--color-primary-light` background with `--color-primary` text, remaining visible against dark surfaces. |
| V9 | Focus ring: 2px `--color-primary`, offset 2px — unchanged across themes. |
| V10 | Images, illustrations, and logos with light-mode-specific assets provide a dark-mode counterpart where warranted (e.g., empty-state illustrations). |

### Accessibility

| # | Requirement |
|---|-------------|
| A1 | Body text contrast ratio ≥ 4.5:1 (WCAG AA). |
| A2 | Large text and UI element contrast ratio ≥ 3:1. |
| A3 | Focus indicators visible against both `--color-bg` and `--color-surface` in dark mode. |
| A4 | No information is conveyed by color alone — status icons accompany color changes. |

### Platform

| # | Requirement |
|---|-------------|
| P1 | Web: Chrome, Safari, Firefox, Edge latest two major versions. |
| P2 | iOS native app: all supported versions of Just Maple's iOS target. |
| P3 | Native status bar / system chrome aligns with the active theme. |

---

## Success metrics

Dark mode is a quality-of-life feature, so the measurement frame is adoption and satisfaction rather than top-line growth.

**Primary metrics (measured 30 days post-launch):**

- **Adoption rate.** % of weekly active users who have enabled dark mode at least once. Target: ≥ 35%.
- **Stickiness.** % of users who enabled dark mode and still have it on 7 days later. Target: ≥ 80%.
- **Qualitative satisfaction.** In-product survey to users who have enabled dark mode: "How satisfied are you with dark mode?" Target: ≥ 4.3 / 5 average.

**Secondary / guardrail metrics:**

- **Theme-related bug reports per 1000 WAU.** Target: ≤ 2 / 1000 / week after week 2 (allowing for initial burn-in).
- **Theme-switch latency (p95).** Target: < 100ms from toggle to fully-repainted UI.
- **No regression in editor typing latency** (p95 input-to-paint) between themes.
- **No regression in evening-session length** — we want dark mode to enable more comfortable late use, not just shift existing use.

**Signals to listen for (not formal metrics):**

- Support-ticket keywords: "dark mode", "can't read", "too bright", "white flash".
- App Store / Play Store review mentions of dark mode sentiment.
- Unsolicited Slack / Twitter mentions.

---

## High-level approach

At a product level, delivery breaks into four phases. Engineering specifics live in `docs/eng-theming.md`.

**Phase 1 — Audit and gap closure.** Inventory every component, modal, popover, widget, and embed. Flag any that hardcode colors or don't resolve against the existing `--color-*` tokens. Close those gaps so the existing `.dark` class, when applied, renders the app end-to-end without visual defects.

**Phase 2 — Settings surface.** Ship the user-facing toggle in Settings → Appearance. Persist to `localStorage` (device) and to the user's account record (cross-device sync). Wire the iOS native bridge so the status bar updates on theme change.

**Phase 3 — Polish.** Dark-mode-specific asset swaps (empty-state illustrations, the login splash), scrollbar treatment, selection and focus calibration, widget-by-widget QA pass.

**Phase 4 — Measure and iterate.** Instrument the adoption, stickiness, and latency metrics above. Run the satisfaction survey 14 days after GA. Triage incoming bug reports; publish a follow-up punch list.

---

## Rollout

Dark mode is low-risk — it doesn't touch data, only presentation — so rollout can be fairly aggressive:

1. **Internal dogfood (1 week).** Ship to Maple team accounts. Exercise every surface, including signup/login, mobile, and embedded widgets.
2. **Beta (1 week).** Opt-in via a feature flag for the public beta cohort. Collect qualitative feedback and close critical visual bugs.
3. **GA — 100% rollout.** No gradual ramp. Feature is off-by-default; users opt in from Settings.
4. **Announcement.** In-app toast + changelog entry. No email campaign.

---

## Risks and open questions

**Risks**

- *Incomplete coverage.* Any component that hardcodes a color (e.g., `bg-white`, `text-gray-800`) will render incorrectly in dark mode. The Phase 1 audit is the mitigation, but the long tail of third-party embeds (TipTap, whiteboard) is the highest-risk area.
- *Cross-device sync lag.* If the account-level sync is slow, a user who flips dark mode on their phone may briefly see light mode on their laptop. Acceptable at GA; keep an eye on reports.
- *Accessibility regressions.* Contrast can look fine to sighted reviewers but fail WCAG. Mitigation: automated contrast checks in the design-review process, not just visual sign-off.

**Open questions**

- Should dark mode be promoted once (e.g., a one-time toast "Dark mode is here — try it") or left purely discoverable in Settings?
- Do we need a dark-mode variant of the brand illustration on the empty-state screens, or is a lower-opacity version of the existing asset good enough?
- Should the login screen respect the system dark preference as a special case (since the user isn't signed in yet and we can't read their stored preference)? This is the one place where an exception to the "manual opt-in only" rule might be worth making.

---

## Appendix A — Reference token values

For convenience. Authoritative source is `apps/web/src/styles.scss` and `docs/eng-theming.md`.

| Token | Light | Dark |
|---|---|---|
| `--color-bg` | `#fdfbf7` | `#1c1917` |
| `--color-surface` | `#ffffff` | `#262524` |
| `--color-surface-alt` | `#f5f2eb` | `#2e2c2a` |
| `--color-surface-hover` | `#f5f5f4` | `#3a3836` |
| `--color-sidebar` | `#f5f2eb` | `#292524` |
| `--color-input-bg` | `#ffffff` | `#1c1917` |
| `--color-text-main` | `#292524` | `#e7e5e4` |
| `--color-text-muted` | `#78716c` | `#a8a29e` |
| `--color-border` | `#e7e5e4` | `#44403c` |
| `--color-primary` | `#993629` | `#993629` |
| `--color-primary-hover` | `#7a2b21` | `#7a2b21` |
| `--color-primary-light` | `#f5e6e4` | `#422016` |
| `--color-bg-hover` | `rgba(0,0,0,0.06)` | `rgba(255,255,255,0.1)` |
| `--color-bg-active` | `rgba(0,0,0,0.1)` | `rgba(255,255,255,0.15)` |

---

## Appendix B — Related docs

- `docs/eng-theming.md` — engineering implementation of theming, ThemeService, token system
- `designs/Just_Maple_Design_System.md` — full design system reference
- `CLAUDE.md` — code conventions; see Styling (Web) section for token usage

---

*End of PRD.*
