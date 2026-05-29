# Responsive Program — PWA Polish

Cross-cutting PWA install/feel polish under the responsive-program epic ([#577](https://github.com/zubair-io/Maple/issues/577)). Web only — the Apple shell is a native app, not a PWA.

Applies equally to both Angular projects: **`projects/maple`** (Self Hosted) and **`projects/maple-syrup`** (Hosted unified SPA).

---

## 1. What ships

1. **`viewport-fit=cover`** on `<meta name="viewport">` so the layout extends under the iOS notch / Android cutout instead of sitting in the safe inset rectangle.
2. **`env(safe-area-inset-*)` CSS**, exposed once as canonical custom properties (`--safe-area-inset-{top,right,bottom,left}`). Every shell surface that touches a screen edge — phone tab-bar (bottom), source-picker drawer (top + bottom), bottom-sheet (bottom) — references the var, not the raw `env()`.
3. **Dark `theme-color`** = `MapleTokens.bg` (`#1c1917`) on `<meta name="theme-color">`, plus the same value in the manifest's `theme_color` + `background_color`. The browser chrome (iOS status bar, Android URL bar, splash screen) then matches the app instead of clashing with the accent red.
4. **Manifest hygiene** — `display: "standalone"`, `id: "/"`, `scope: "/"`, `start_url: "/browse"`, name / short_name, icons array (192, 512, plus a maskable 512), and a `protocol_handlers` entry for `web+maple` → `/protocol-handler?url=%s`. The `web+` prefix is required by the W3C Manifest spec (plain `maple` is silently dropped by Chromium); `ProtocolHandlerComponent` decodes the substituted URL and redirects to the canonical Angular route. The iOS side keeps the bare `maple://` scheme (separate iOS deep-link spec, TBD); the web handler accepts both forms.
5. **Apple-specific PWA meta** — `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-status-bar-style=black-translucent`, and an `apple-touch-icon` link. Without these the "Add to Home Screen" install on iOS renders a translucent white status bar over the dark app.

---

## 2. Files touched per app

For each of `projects/maple` and `projects/maple-syrup`:

| File                               | Change                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/index.html`                   | `viewport-fit=cover` on the viewport meta; theme-color meta → `#1c1917`; apple-mobile-web-app meta + apple-touch-icon link |
| `src/manifest.webmanifest`         | Add `id`, `scope`, dark `theme_color`, maskable icon entry, `protocol_handlers`                                            |
| `src/assets/icon-512-maskable.png` | New — 512px PNG with ~20% safe-area padding so Android's adaptive icon mask doesn't crop the wordmark                      |

Shared (maple-common):

| File                                                                                            | Change                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `projects/maple-common/src/lib/safe-area.scss` (new)                                            | Emits `--safe-area-inset-{top,right,bottom,left}: env(safe-area-inset-{top,right,bottom,left}, 0px)` at `:root` |
| `projects/maple-common/src/lib/shells/phone-tab-shell.component.scss`                           | Switch literal `env(safe-area-inset-bottom)` → `var(--safe-area-inset-bottom)`                                  |
| `projects/maple-common/src/lib/shells/source-picker-drawer/source-picker-drawer.component.scss` | Top + bottom padding via the vars on `.drawer-header` / `.source-tree`                                          |
| `projects/maple-common/src/lib/shells/bottom-sheet.component.scss`                              | `padding-bottom: var(--safe-area-inset-bottom)` on `.sheet` so content clears the home indicator                |

Each app's `src/styles.scss` `@use`s `safe-area.scss` after `tokens` so the custom properties are available globally.

---

## 3. Implementation notes

**Safe-area as a token, not a raw `env()` call.** A single source of truth (`safe-area.scss` → `--safe-area-inset-*`) means consumers don't repeat the `env(..., 0px)` fallback dance and the codebase has one search-replace target if we ever switch to dynamic viewport units.

**Theme-color binding to `MapleTokens.bg`.** The value is hardcoded in `index.html` rather than templated, because the meta tag is parsed before Angular bootstraps — there's no way to wire it through the token codegen. The string is short and the only risk is drift; if `MapleTokens.bg` ever changes, both `index.html` files need a manual update (a one-line grep). A future ticket can add a CI smoke test in `tokens.spec.ts` that asserts the literal matches.

**`protocol_handlers`.** Per [W3C Manifest §protocol_handlers](https://www.w3.org/TR/manifest-app-info/#protocol_handlers-member), only safelisted protocols or `web+`-prefixed ones are accepted. We register `web+maple` → `/protocol-handler?url=%s`. The browser substitutes the entire invoked URL (e.g. `web+maple://image/abc`, percent-encoded) into `%s`, so a literal `/library/editor/%s` would feed the whole URL into `:id` instead of the image id. The dedicated `ProtocolHandlerComponent` (in `maple-common`) decodes the param, parses both `web+maple://image/<id>` and the bare `maple://image/<id>` form that the iOS app registers, and redirects to `/library/editor/<id>`. The iOS deep-link spec is tracked separately. Chromium-only; Safari ignores the manifest field.

**Maskable icon.** Generated by resizing the existing 512px icon to ~60% of the canvas, centred on a `#1c1917` background — meets Android adaptive-icon "minimum safe zone" (a 40% padded circle). Lives next to the existing icons so the `assetGroups` glob in `ngsw-config.json` picks it up.

---

## 4. Verification

- `ng build maple` and `ng build maple-syrup` succeed; `dist/.../manifest.webmanifest` contains the new fields.
- Chrome DevTools → **Application → Manifest**: no errors; installability check green; icons render.
- Chrome DevTools → **Lighthouse → PWA**: score ≥ 90 on both apps.
- iOS Simulator (Safari): "Add to Home Screen" → launched PWA shows dark status bar (not white), tab bar clears the home indicator.
- Phone-tier screenshot at 375 × 812 (iPhone 17 Pro viewport) via Chrome device emulation: tab bar respects safe-area-bottom; nothing clips.

---

## 5. Out of scope (v0.1)

- **Push notifications** — needs server-side push infrastructure + permission flow.
- **Background sync** — defer until offline-first XMP write queue lands.
- **Share target** (`share_target` manifest field) — would let users share a RAW _into_ Maple from the OS share sheet; separate spec.
- **Universal Links** (HTTPS deep links) — Maple Cloud sharing surface ships first.
- **Custom splash screen artwork** — iOS uses the icon + `background_color`; Android auto-generates from the maskable. Bespoke art is a later visual-design pass.
- **`launch_handler`** for focus-existing vs. new-window — defaults are fine until multi-window UX is designed.
