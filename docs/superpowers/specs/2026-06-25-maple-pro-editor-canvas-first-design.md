# Maple Pro Editor — Canvas-first design spec

**Date:** 2026-06-25
**Issue:** #1535 (M1), **Epic:** #1534
**Branch:** `claude/pro-editor-web-m1`

## Overview

A presentation rebuild of the web editor: full-bleed `<image-canvas>` occupies the entire viewport, with floating glass chrome layered above. The state/render/tool-model layers are unchanged.

## Breakpoints

| Viewport            | Layout                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `<768px` phone      | Top glass bar (`back · name · mini-histogram · ⋯`) + one full-width bottom control card (group chips + 1-col living sliders). No tool dock. |
| `768–1100px` tablet | Top bar (`back · name · histogram · split · export`) + right vertical tool dock + 2-col control card.                                       |
| `≥1100px` desktop   | Same as tablet + hover affordances, **no auto-recede**.                                                                                     |

## Components

### Pro tokens (`pro-tokens.scss`)

Hand-written SCSS (not codegen output). Emits CSS custom properties at `:root`:

- `--pro-bg`, `--pro-canvas`, `--pro-canvas-alt`, `--pro-panel`
- `--pro-border`, `--pro-border-hi`
- `--pro-text`, `--pro-text-muted`, `--pro-text-dim`
- `--pro-accent: #c4493a` + alpha variants `--pro-accent-1f/22/28/30`
- `--pro-star: #ef9f27`, `--pro-ok: #62c172`
- Glass material tokens: `--pro-glass-bg/blur/border/shadow/radius-*`
- Motion tokens: `--pro-motion-recede/hud-in/hud-out/group/card`

Accent-derived fills use **only** the alpha suffix variants — never a separate hex.

### Gradient catalog (`gradient-catalog.ts`)

Single source mapping every wired `ToolId` → CSS `linear-gradient`. A unit test (`gradient-catalog.spec.ts`) asserts completeness: every entry in `ALL_TOOLS` has a gradient.

Sub-param overrides keyed as `<toolId>/<subParamId>`.

> TODO: replace placeholder stop colours with exact values from `_design-reference/lib/primitives.jsx` GRAD constants (#1535 follow-up).

### LivingSlider (`living-slider.component`)

Replaces `EditorSliderComponent` in the Pro Editor context.

- Track: 8–9px rounded, gradient background, inset hairline + inner shadow
- Bipolar: 1.5px white zero-notch at midpoint
- Thumb: white, track+8px, dark rim; **2px accent ring** when `value ≠ defaultValue`
- Value chip: mono tabular-nums, signed, accent when modified / dim at 0
- Drag: 1:1 pointer capture on track
- Double-click: emits `resetRequest`

### ValueHud (`value-hud.component`)

Center overlay during canvas scrub:

- Eyebrow: group/tool name, muted uppercase
- Large mono signed value in accent colour
- Thin progress rail (2px, accent fill, white center tick)
- Phone: value 30px / rail 200px. Desktop (`.shell--desktop` context): value 22px / rail 240px
- Fade-in: 120ms ease-out. Fade-out: 600ms ease-out (after scrub ends)

### ToolDock (`tool-dock.component`)

Vertical glass column, tablet/desktop only. 8 entries (46px targets):

| Entry   | Group switch | Status                                  |
| ------- | ------------ | --------------------------------------- |
| Light   | `light`      | Active                                  |
| Color   | `color`      | Active                                  |
| Curve   | —            | **Disabled** — coming in #1536          |
| Effects | `effects`    | Active                                  |
| Detail  | `detail`     | Active                                  |
| Optics  | —            | **Disabled** — coming in #1537          |
| Mask    | —            | **Disabled** — coming in #1538 (web M3) |
| Heal    | —            | **Disabled** — coming in #1472          |

Disabled entries show tooltip + code comment with ticket number. No fake panels (CLAUDE.md #6).

### MaskChip (`mask-chip.component`)

Lower-left glass chip. **Disabled in M1** — masking does not exist yet. A fake contour would violate CLAUDE.md principle #6. Will be activated in web M3 (#1538).

### ControlCard (`control-card.component`)

Bottom floating glass card:

- Group chip row (4 groups; active = `--pro-accent-28` fill + accent border)
- Living-slider grid: 1 col phone / 2 col tablet+desktop
- Grab handle: collapses between `full` (sliders visible) and `peek` (chips only)
- Reset button (`revert` icon): zeros all sliders in the active group
- Per-slider double-click: zeros that slider via `resetRequest` output

### Rebuilt EditorShell (`editor-shell.component`)

All routing/address-resolution logic preserved verbatim. New additions:

**Canvas scrub:** At fit-zoom (pixelScale === 0), horizontal pointer drag scrubs the armed tool at **0.5:1** sensitivity. Calls `editorState.commit()` on drag start, `setArmedInternalValue()` on move, shows the ValueHUD during the drag, fades HUD 600ms after release.

**Chrome recede:** `chromeState` signal drives opacity:

- `full`: opacity 1
- `receded`: opacity 0.3 (after 3s idle, phone/tablet only)
- `scrubbing`: opacity 0.15 (during canvas drag)
- Desktop (≥1100px): never recedes

**Keyboard extensions** (on top of preserved bindings):

- `1–4`: switch tool group (Light/Color/Effects/Detail)
- `←/→` bare: prev/next image (existing); with Shift: ±10 internal value
- `F`: fit zoom
- `Z`: 1:1 zoom
- `R`: reset group (wired via resetGroup on ControlCard)
- `\` or `b`: before/after toggle

## Glass material

Phone/tablet (lighter):

```css
background: rgba(18, 16, 14, 0.58);
backdrop-filter: blur(26px) saturate(150%);
border: 0.5px solid rgba(255, 255, 255, 0.13);
box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
border-radius: 14px (bars) / 16px (cards);
```

Desktop/tablet (heavier):

```css
background: rgba(20, 18, 15, 0.62);
backdrop-filter: blur(22px) saturate(140%);
border-radius: 22px;
```

## Motion tokens

| Token                  | Value                             | Use                   |
| ---------------------- | --------------------------------- | --------------------- |
| `--pro-motion-recede`  | `180ms ease-out`                  | Chrome dim/restore    |
| `--pro-motion-hud-in`  | `120ms ease-out`                  | HUD appear            |
| `--pro-motion-hud-out` | `600ms ease-out`                  | HUD disappear         |
| `--pro-motion-group`   | `120ms linear`                    | Group chip cross-fade |
| `--pro-motion-card`    | `260ms cubic-bezier(.22,1,.36,1)` | Card collapse         |

## Definition of done (M1)

- [x] Canvas-first layered editor replaces old 3-column shell, responsive at <768 / 768–1100 / ≥1100
- [x] Living gradient slider throughout Develop; gradient-catalog covers every wired ToolId (completeness test)
- [x] Canvas-at-fit horizontal drag scrubs armed tool at 0.5:1 with ValueHUD
- [x] Floating glass chrome: top bar, control card with chips + grab-handle collapse, tool dock, mask chip, value HUD
- [x] Chrome recede + desktop opt-out
- [x] before/after + histogram present; dock Curve/Optics/Heal + mask chip disabled-with-ticket (no fake panels)
- [ ] vitest: no new failures + gradient-catalog spec passes
- [ ] prettier clean on main...HEAD
- [ ] `ng build maple` succeeds
- [ ] PR opened ready, Closes #1535
